
// Application Logic
const App = {
    state: {
        // Tree structure for files and folders
        root: {
            type: 'folder',
            name: 'root',
            expanded: true,
            children: [
                { 
                    type: 'file',
                    name: 'imports.py',
                    content: '# Anything imported here is accessible in the entire project.\n\nfrom compas.geometry import Box, Frame, Point, Vector\nimport math\n',
                    // content: "# Anything imported here is accessible in the entire project.\nimport compas.geometry as cg\nimport compas.datastructures as cd\n\nfrom compas.geometry import Box\nfrom compas.geometry import Sphere\nfrom compas.geometry import Cylinder\nfrom compas.geometry import Cone\nfrom compas.geometry import Torus\nfrom compas.geometry import Mesh\nfrom compas.geometry import NurbsSurface\nfrom compas.geometry import Line\nfrom compas.geometry import Point\nfrom compas.geometry import Polyline\nfrom compas.geometry import Circle\n",
                    lastOutput: null
                },
                { 
                    type: 'file',
                    name: 'read_me.py', 
                    content: "# Activating Live coding will run your code as soon as you stop typing.\n\n# Using the syntax //# range (x, y)// will create a slider. For example:\na = 0 # range(0, 10)\n\n# Using the syntax //# switch (var1, var2, var3)// will create a switch. For example:\ncurrent_number = 0 # switch(0, 1, 2)\n\n# Use the prefix glb_ in front of variable names to use them in other files.\n\n# Click on geometry in the viewport to add their corresponding variable name to the current editor.",
                    lastOutput: null
                }
            ]
        },
        editors: {}, // Map path -> editor instance
        openFiles: new Set(), // Set of open file paths
        activeFile: null, // Last focused file path (for viewport interactions)
        activeFolder: null, // Currently selected folder for creation
        draggingNode: null // Node currently being dragged
    },
    
    viewport: null,
    socket: null,
    isRemoteUpdate: false,

    async callServer(endpoint, body) {
        if (!this.state.currentProjectName) return;
        try {
            const res = await fetch(`/project/${encodeURIComponent(this.state.currentProjectName)}/${endpoint}`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!data.success) {
                console.error(`Server error on ${endpoint}:`, data.error);
                this.showNotification(`Error: ${data.error}`, 'error');
                return false;
            }
            return true;
        } catch (e) {
            console.error(`Network error on ${endpoint}:`, e);
            return false;
        }
    },

    findNodePath(node, current = this.state.root, path = '') {
        if (current === node) return path;
        if (!current.children) return null;
        
        for (const child of current.children) {
            const childPath = path ? `${path}/${child.name}` : child.name;
            const found = this.findNodePath(node, child, childPath);
            if (found !== null) return found;
        }
        return null;
    },

    init() {
        if (this.initialized) return;
        this.initialized = true;

        // --- SOCKET SETUP ---
        if (typeof io !== 'undefined') {
            this.socket = io();
            this.socket.on('connect', () => console.log("Connected to WebSocket"));
            
            this.socket.on('code_update', (data) => {
                // Ignore updates for other projects
                if (data.project !== this.state.currentProjectName) return;
                
                // Update internal state
                const fileNode = this.state.root.children.find(c => c.name === data.filename);
                if (fileNode) {
                    fileNode.content = data.content; 
                }

                // If editor is open, update visual state
                const editor = this.state.editors[data.filename];
                if (editor) {
                    this.isRemoteUpdate = true;
                    const model = editor.getModel();
                    
                    // Apply efficient delta updates
                    if (data.changes && Array.isArray(data.changes)) {
                        const edits = data.changes.map(c => ({
                            range: c.range,
                            text: c.text,
                            forceMoveMarkers: true 
                        }));
                        model.applyEdits(edits);
                    } else {
                        // Fallback to full content replacement
                        const pos = editor.getPosition();
                        editor.setValue(data.content);
                        editor.setPosition(pos);
                    }
                    this.isRemoteUpdate = false;
                }
            });
        }

        // Viewport Setup
        this.viewport = new ViewportManager('viewport');
        this.viewport.onObjectSelected = (name) => this.onViewportSelection(name);

        this.setupSplitter();
        this.setupNavigation();
        
        console.log("System initialized.");

        // Warmup
        this.warmupKernel();
    },

    async loadProject(projectId) {
        // Ensure initialized
        if (!this.initialized) this.init();

        // Cleanup if switching projects
        if (this.state.currentProjectName && this.state.currentProjectName !== projectId) {
            console.log("Switching project, cleaning up...");
            if (this.socket) this.socket.emit('leave', { project: this.state.currentProjectName });
            
            // Clear editors
            this.state.openFiles.forEach(f => {
                if (this.state.editors[f]) {
                    this.state.editors[f].dispose();
                    delete this.state.editors[f];
                }
            });
            this.state.openFiles.clear();
            this.state.activeFile = null;
            
            // Clear Viewport Objects
            if (this.viewport && this.viewport.fileObjects) {
                this.viewport.fileObjects.forEach((meshes) => {
                    meshes.forEach(m => {
                         if (m.geometry) m.geometry.dispose();
                         this.viewport.scene.remove(m);
                    });
                });
                this.viewport.fileObjects.clear();
            }
        }

        this.state.currentProjectName = projectId;
        console.log("Loading Project:", projectId);
        
        // Join Socket Room
        if (this.socket) this.socket.emit('join', { project: projectId });
        
        // Load file structure from server
        await this.loadProjectFiles(projectId);
        
        // Load workspace state
        await this.loadWorkspaceState();

        // Run imports after loading
        // this.runImports(); // Removed duplicate call (handled in loadProjectFiles)
    },


    async loadProjectFiles(projectName) {
        console.log("Loading files for project:", projectName);
        try {
            const res = await fetch(`/project/${encodeURIComponent(projectName)}/files`);
            const data = await res.json();
            
            if (data.success) {
                // Update project title
                this.state.projectDisplayName = data.projectName || projectName;
                
                // Construct root
                const newRoot = {
                    type: 'folder',
                    name: 'root', // Keep name as root for internal logic
                    expanded: true,
                    children: []
                };

                // Helper to add file/folder to tree recursively
                const ensurePath = (pathParts, parent) => {
                    const currentPart = pathParts[0];
                    if (!currentPart) return parent;

                    let node = parent.children.find(c => c.name === currentPart);
                    
                    if (pathParts.length === 1) {
                         // This is the leaf file
                         // If existing node (folder with same name?), conflict. Assuming files.
                         if (!node) {
                             node = {
                                 type: 'file',
                                 name: currentPart,
                                 content: '',
                                 lastOutput: null
                             };
                             parent.children.push(node);
                         }
                         return node;
                    } else {
                         // This is a directory
                         if (!node) {
                             node = {
                                 type: 'folder',
                                 name: currentPart,
                                 expanded: true, // Auto-expand restored folders? Maybe
                                 children: []
                             };
                             parent.children.push(node);
                         }
                         return ensurePath(pathParts.slice(1), node);
                    }
                };
                 
                data.files.forEach(f => {
                   const parts = f.name.split('/'); // Assuming unix paths from server
                   const node = ensurePath(parts, newRoot);
                   node.content = f.content;
                   if (f.type && f.type === 'folder') {
                       node.type = 'folder';
                       if (!node.children) node.children = [];
                   } else {
                       node.type = 'file'; 
                   }
                });

                // Sort files: Folders first, then alphabetically
                const sortNode = (node) => {
                    if (node.children) {
                        node.children.sort((a, b) => {
                            // 1. Folders First
                            if (a.type !== b.type) {
                                return a.type === 'folder' ? -1 : 1;
                            }
                            // 2. Alphabetical (Case Insensitive)
                            return a.name.localeCompare(b.name, undefined, {sensitivity: 'base', numeric: true});
                        });
                        node.children.forEach(sortNode);
                    }
                };
                sortNode(newRoot);

                this.state.root = newRoot;
                this.renderExplorer();
                this.runImports();
                
                // Load workspace state
                this.loadWorkspaceState();

            } else {
                 console.error("Failed to load project files:", data.error);
                 alert("Could not load project files: " + data.error);
            }
        } catch (e) {
            console.error("Error loading project:", e);
        }
    },


    async loadWorkspaceState() {
        if (!this.state.currentProjectName) return;
        try {
            const res = await fetch(`/project/${encodeURIComponent(this.state.currentProjectName)}/workspace`);
            const data = await res.json();
            
            if (data.openFiles && Array.isArray(data.openFiles)) {
                this.state.openFiles = new Set(data.openFiles);
                this.state.activeFile = data.activeFile || null;
                
                // Restore Node States (Folders expanded, File settings)
                if (data.nodeStates) {
                    Object.entries(data.nodeStates).forEach(([path, state]) => {
                         const node = this.findNodeByPath(path);
                         if (node) {
                             if (state.expanded !== undefined) node.expanded = state.expanded;
                             if (state.editorHeight) node.editorHeight = state.editorHeight;
                             if (state.isLive !== undefined) node.isLive = state.isLive;
                             if (state.lastOutput) node.lastOutput = state.lastOutput;
                         }
                    });
                }

                // Restore UI State
                if (data.uiState) {
                    if (data.uiState.splitterWidth) {
                        const splitter = document.getElementById('left-panel');
                        if (splitter) {
                            splitter.style.width = data.uiState.splitterWidth;
                            if (this.viewport && this.viewport.onWindowResize) this.viewport.onWindowResize();
                        }
                    }
                    if (data.uiState.activeFolder) {
                        const folder = this.findNodeByPath(data.uiState.activeFolder);
                        if (folder && folder.type === 'folder') {
                            this.state.activeFolder = folder;
                        }
                    }
                }
                
                // Trigger visibility updates
                this.state.openFiles.forEach(path => {
                    this.viewport.setFileVisibility(path, true);
                });
                
                this.renderExplorer();
            }
        } catch (e) {
            console.error("Failed to load workspace state:", e);
        }
    },
    
    saveFileToServer(filename, content) {
        if (!this.state.currentProjectName) return;
        
        fetch(`/project/${encodeURIComponent(this.state.currentProjectName)}/save`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ filename, content })
        }).then(res => res.json())
          .then(d => {
              if (!d.success) console.error("Save failed:", d.error);
              else console.log("Auto-saved", filename);
          })
          .catch(e => console.error(e));
    },

    setupNavigation() {
        // Handle Viewport vs Layout toggle
        const btn3d = document.getElementById('btn-vp-3d');
        const btnLayout = document.getElementById('btn-vp-layout');
        const viewport = document.getElementById('viewport');
        const layoutView = document.getElementById('layout-view');

        const setMode = (mode) => {
            if (mode === '3d') {
                btn3d.classList.add('active');
                btnLayout.classList.remove('active');
                viewport.style.display = 'block';
                layoutView.style.display = 'none';
                if (this.viewport && this.viewport.onWindowResize) this.viewport.onWindowResize();
            } else {
                btn3d.classList.remove('active');
                btnLayout.classList.add('active');
                viewport.style.display = 'none';
                layoutView.style.display = 'flex';
            }
        };

        if (btn3d && btnLayout) {
             btn3d.addEventListener('click', () => setMode('3d'));
             btnLayout.addEventListener('click', () => setMode('2d'));
        }
    },

    async warmupKernel() {
        console.log("Warming up kernel...");
        try {
            await fetch('/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    filename: 'warmup.py', 
                    code: 'print("Kernel Warnup")', 
                    pre_import_code: '',
                    project: this.state.currentProjectName
                })
            });
            console.log("Kernel warmed up.");
        } catch (e) {
            console.warn("Kernel warmup failed (non-critical):", e);
        }
    },

    async runImports() {
        console.log("Running imports...");
        const importsFile = this.state.root.children.find(child => child.name === 'imports.py');
        if (!importsFile) {
            console.warn("imports.py not found");
            return;
        }

        try {
            await fetch('/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    filename: importsFile.name, 
                    code: importsFile.content, 
                    pre_import_code: '',
                    project: this.state.currentProjectName
                })
            });
            console.log("imports.py executed.");
        } catch (e) {
            console.warn("Running imports.py failed:", e);
        }
    },

    // --- EXPLORER RENDERING ---

    renderExplorer() {
        const wrapper = document.getElementById('file-list-wrapper');
        // Clear current content (simple redraw)
        wrapper.innerHTML = '';
        
        // 1. Toolbar
        this.renderToolbar(wrapper);

        // 2. Tree Container
        const treeContainer = document.createElement('div');
        treeContainer.className = 'file-tree';
        wrapper.appendChild(treeContainer);
        
        // Root is also a drop target (for moving items to top level)
        treeContainer.ondragover = (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            treeContainer.style.background = '#e8e8e8';
        };
        treeContainer.ondragleave = (e) => {
             treeContainer.style.background = '';
        };
        treeContainer.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation(); // Stop bubbling
            treeContainer.style.background = '';
            
            // If dropping on the container itself (and not a specific folder row), move to root
            // We need to check if the drop target was actually the container or close to it
            // Simple logic: if we are here, we are dropping into Root
            if (this.state.draggingNode) {
                this.moveNode(this.state.draggingNode, this.state.root);
            }
        };

        // 3. Render Root Children
        // We start with empty path prefix
        if (this.state.root.children) {
            this.state.root.children.forEach(child => {
                this.renderNode(child, treeContainer, ""); 
            });
        }
    },

    renderToolbar(wrapper) {
        const toolbar = document.createElement('div');
        toolbar.className = 'explorer-toolbar';
        
        // --- Navigation / Project Title ---
        const navContainer = document.createElement('div');
        navContainer.style.display = 'flex';
        navContainer.style.alignItems = 'center';
        navContainer.style.gap = '8px';

        // Back Button
        const backBtn = document.createElement('span');
        backBtn.innerText = '←';
        backBtn.style.cursor = 'pointer';
        backBtn.style.fontSize = '14px';
        backBtn.style.fontWeight = 'bold';
        backBtn.title = "Back to Projects";
        backBtn.onclick = () => { 
            if (typeof showProjectList === 'function') {
                showProjectList();
            } else {
                window.location.href = '/'; 
            }
        };
        
        // Project Title
        const title = document.createElement('span');
        title.innerText = this.state.projectDisplayName || this.state.currentProjectName || 'Loading...';
        title.className = 'explorer-title';
        title.style.fontSize = '13px'; // Slightly larger for project name

        navContainer.append(backBtn, title);

        // Add info about active folder if any?
        if (this.state.activeFolder) {
            const subtitle = document.createElement('span');
            subtitle.innerText = ` / ${this.state.activeFolder.name}`;
            subtitle.style.fontSize = '11px';
            subtitle.style.color = 'var(--text-color-secondary)';
            navContainer.appendChild(subtitle);
        }
        
        // --- Actions ---
        const actions = document.createElement('div');
        actions.className = 'explorer-actions';

        // New File
        const newFileBtn = document.createElement('span');
        newFileBtn.innerText = '📄+ ';
        newFileBtn.title = "New File";
        newFileBtn.className = 'icon-btn';
        newFileBtn.onclick = () => this.createNode('file');

        // New Folder
        const newFolderBtn = document.createElement('span');
        newFolderBtn.innerText = '📁+ ';
        newFolderBtn.title = "New Folder";
        newFolderBtn.className = 'icon-btn';
        newFolderBtn.onclick = () => this.createNode('folder');

        // Import File
        const importBtn = document.createElement('span');
        importBtn.innerText = '📥 ';
        importBtn.title = "Import File";
        importBtn.className = 'icon-btn';
        importBtn.onclick = () => this.importFile();

        actions.append(newFileBtn, newFolderBtn, importBtn);
        toolbar.append(navContainer, actions);
        wrapper.appendChild(toolbar);
    },

    renderNode(node, container, parentPath) {
        const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;

        if (node.type === 'folder') {
            const folderRow = document.createElement('div');
            folderRow.className = 'tree-row folder-row';

            // Drag Source
            folderRow.draggable = true;
            folderRow.ondragstart = (e) => {
                e.stopPropagation();
                this.state.draggingNode = node;
                // e.dataTransfer.setData('text/plain', node.name);
                e.dataTransfer.effectAllowed = 'move';
                folderRow.style.opacity = '0.5';
            };
            folderRow.ondragend = () => {
                folderRow.style.opacity = '1';
                this.state.draggingNode = null;
            };

            // Drop Target
            folderRow.ondragover = (e) => {
                e.preventDefault();
                e.stopPropagation();
                // Prevent dropping into itself or its own children
                // We'll manage this in ondrop
                if (this.state.draggingNode === node) return;
                folderRow.style.background = '#ccc'; // Highlight
            };
            folderRow.ondragleave = (e) => {
                // e.stopPropagation();
                // We clear specific highlight only.
                // Revert to normal/selected style
                folderRow.style.background = (this.state.activeFolder === node) ? '#e0e0e0' : '';
            };
            folderRow.ondrop = (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                // Revert style
                folderRow.style.background = (this.state.activeFolder === node) ? '#e0e0e0' : '';

                if (this.state.draggingNode && this.state.draggingNode !== node) {
                    this.moveNode(this.state.draggingNode, node);
                }
            };
            
            // Allow selecting folder for creation
            if (this.state.activeFolder === node) {
                 folderRow.style.border = '1px solid #007acc';
                 folderRow.style.background = '#e0e0e0';
            }
            
            // Icon
            const icon = document.createElement('span');
            icon.innerText = node.expanded ? '▼ 📁 ' : '▶ 📁 ';
            icon.style.fontFamily = 'monospace';
            icon.style.marginRight = '5px';
            // Separate expand toggle to icon only?
            // "The same way that when one clicks on a python file, it opens or closes the editor" 
            // -> For file: click row toggles editor.
            // -> For folder: click row toggles "active" state.
            // -> We must keep expand separate or combine them?
            // If we combine them: click -> expand AND set active? 
            // User request: "can a folder be 'active' when clicked on once... and 'deactivated' when clicked on again"
            // Let's make the click on the whole row toggle Active status.
            // And use the icon specifically for expansion.
           
            icon.onclick = (e) => {
                e.stopPropagation();
                node.expanded = !node.expanded;
                this.renderExplorer();
            };
            
            // Name
            const nameSpan = this.createNameElement(node);

            // Controls
            const controls = document.createElement('div');
            controls.className = 'row-controls';
            
            // Rename
            const renameBtn = document.createElement('span');
            renameBtn.innerText = '✎';
            renameBtn.className = 'icon-btn';
            renameBtn.title = "Rename";
            renameBtn.onclick = (e) => { e.stopPropagation(); node.isRenaming = true; this.renderExplorer(); };

            // Delete
            const delBtn = document.createElement('span');
            delBtn.innerText = '−';
            delBtn.className = 'icon-btn delete-btn';
            delBtn.title = "Delete Folder";
            delBtn.onclick = (e) => { e.stopPropagation(); this.deleteNode(node, this.state.root); };
            
            controls.append(renameBtn, delBtn);
            folderRow.append(icon, nameSpan, controls);
            
            folderRow.onclick = (e) => {
                if (!e.target.classList.contains('icon-btn') && !e.target.classList.contains('rename-input')) {
                    // Toggle Active State
                    if (this.state.activeFolder === node) {
                        this.state.activeFolder = null;
                    } else {
                        this.state.activeFolder = node;
                        // Auto-expand when selecting
                        node.expanded = true; 
                    }
                    this.renderExplorer();
                }
            };
            
            container.appendChild(folderRow);

            // Children Container
            if (node.expanded) {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = 'tree-children';
                childrenContainer.style.paddingLeft = '15px';
                childrenContainer.style.borderLeft = '1px solid #ddd';
                
                node.children.forEach(child => {
                    this.renderNode(child, childrenContainer, currentPath);
                });
                container.appendChild(childrenContainer);
            }

        } else if (node.type === 'file') {
            const fileRow = document.createElement('div');
            fileRow.className = 'tree-row file-row';
            
            // Drag Source
            fileRow.draggable = true;
            fileRow.ondragstart = (e) => {
                e.stopPropagation();
                this.state.draggingNode = node;
                // e.dataTransfer.setData('text/plain', node.name);
                e.dataTransfer.effectAllowed = 'move';
                fileRow.style.opacity = '0.5';
            };
            fileRow.ondragend = () => {
                fileRow.style.opacity = '1';
                this.state.draggingNode = null;
            };
            // Files are not drop targets, but prevent bubbling so we don't drop ON a file into a folder accidentally?
            // Actually bubbling to parent folder is fine if we drag onto a file.
            // But let's prevent drop on file row itself to avoid confusion.
            fileRow.ondragover = (e) => {
                e.preventDefault(); 
                // Don't visualize drop target here
            };
            fileRow.ondrop = (e) => {
                // If we bubble, it goes to parent container/folder. 
                // If we stop here, we drop "on the file". 
                // Let just allow bubbling so users can drop "near" a file to put in same folder.
                // Or maybe block it?
                // Let's block it so users have to drop on valid targets (Folders or Root Area)
                // e.stopPropagation();
            };
            
            const isOpen = this.state.openFiles.has(currentPath);
            if (isOpen) fileRow.classList.add('selected');

            const icon = document.createElement('span');
            icon.innerText = '🐍 '; 
            
            const nameSpan = this.createNameElement(node);
            
            const controls = document.createElement('div');
            controls.className = 'row-controls';

            // Rename
            const renameBtn = document.createElement('span');
            renameBtn.innerText = '✎';
            renameBtn.className = 'icon-btn';
            renameBtn.title = "Rename";
            renameBtn.onclick = (e) => { e.stopPropagation(); node.isRenaming = true; this.renderExplorer(); };

            // DL
            const dlBtn = document.createElement('span');
            dlBtn.innerText = '↓';
            dlBtn.className = 'icon-btn';
            dlBtn.title = "Download";
            dlBtn.onclick = (e) => { e.stopPropagation(); this.downloadFile(node); };

            // Save
            const saveBtn = document.createElement('span');
            saveBtn.innerText = '💾';
            saveBtn.className = 'icon-btn';
            saveBtn.title = "Save As";
            saveBtn.onclick = (e) => { e.stopPropagation(); this.saveFileAs(node); };
            
            // Del
            const delBtn = document.createElement('span');
            delBtn.innerText = '−';
            delBtn.className = 'icon-btn delete-btn';
            delBtn.title = "Delete File";
            delBtn.onclick = (e) => { e.stopPropagation(); this.deleteNode(node, this.state.root); };

            controls.append(renameBtn, dlBtn, saveBtn, delBtn);
            fileRow.append(icon, nameSpan, controls);
            
            fileRow.onclick = (e) => {
                 if (!e.target.classList.contains('icon-btn') && !e.target.classList.contains('rename-input')) {
                     this.toggleFile(currentPath, node);
                 }
            };
            
            container.appendChild(fileRow);

            // Editor Area (Accordion Content)
            if (isOpen) {
                const editorDiv = document.createElement('div');
                editorDiv.className = 'tree-editor-area';
                // Unique ID for the editor area to facilitate re-renders without full destruction if needed
                editorDiv.id = `editor-area-${currentPath.replace(/[^a-zA-Z0-9]/g, '_')}`;
                container.appendChild(editorDiv);
                
                // Render editor content
                // We do this immediately to ensure it's in the DOM
                this.renderEditorIn(editorDiv, node, currentPath);
            }
        }
    },

    createNameElement(node) {
        const span = document.createElement('span');
        span.className = 'node-name';
        
        if (node.isRenaming) {
            const input = document.createElement('input');
            input.type = 'text';
            input.value = node.name.replace(/\.py$/, ''); // Show without extension for editing nicety?
            input.className = 'rename-input';
            
            let isCommitting = false;

            const commit = () => {
                if (isCommitting) return; // Prevent re-entry
                isCommitting = true;

                let val = input.value.trim();
                
                if (!val) {
                    if (!node.name) {
                        // If creating new node and cancelled/empty -> remove it
                        const parent = this.findParent(node, this.state.root);
                        if (parent) {
                            parent.children = parent.children.filter(c => c !== node);
                            this.renderExplorer();
                        }
                    } else {
                        // Revert to old name
                        node.isRenaming = false;
                        this.renderExplorer();
                    }
                    isCommitting = false;
                    return;
                }
                
                // Auto-append .py for files
                if (node.type === 'file' && !val.endsWith('.py')) val += '.py';

                // Check for duplicates in the *same* folder (parent)
                const parent = this.findParent(node, this.state.root);
                if (parent) {
                    const exists = parent.children.some(child => child !== node && child.name === val);
                    if (exists) {
                        // Use a non-blocking notification or simple visual indication instead of alert to avoid focus loops
                        // Or, just revert/ignore if duplicate.
                        // Let's force a revert to "untitled" or keep editing?
                        // "Keep editing" is hard with blur loop.
                        // Simplest robust fix: Show error in UI, don't close input, don't alert.
                        
                        // BUT, to satisfy user "loop" issue quickly:
                        // Just cancel the rename if duplicate (revert to old name if exists, or delete if new).
                        // OR: Just add a (1) suffix?
                        
                        // Let's try alert with removed blur handler temporarily
                        input.onblur = null; // Disable blur trigger
                        alert(`"${val}" already exists.`);
                        setTimeout(() => {
                            input.focus(); // Focus back
                            input.onblur = commit; // Re-enable
                            isCommitting = false;
                        }, 50);
                        return;
                    }
                }

                const isNewFile = !node.name;
                const oldName = node.name; // Keep old name for rename path

                // Construct Paths
                // parent is already defined above
                const parentPath = this.findNodePath(parent); // Can act on root too (returns '')
                
                // Helper to construct path string
                const buildPath = (pName) => {
                    return parentPath ? `${parentPath}/${pName}` : pName;
                };

                const newPath = buildPath(val);
                
                if (isNewFile) {
                    node.name = val;
                    node.isRenaming = false;
                    
                    if (node.type === 'folder') {
                        this.callServer('create_folder', { path: newPath });
                    } else {
                        // Create empty file
                        this.saveFileToServer(newPath, '');
                    }
                } else {
                    // Rename Existing
                    const oldPath = buildPath(oldName);
                    
                    this.callServer('rename_node', { oldPath: oldPath, newPath: newPath });
                    
                    // Update Open Files intelligently
                    const updatePaths = (prefixOld, prefixNew) => {
                         const newOpenFiles = new Set();
                         this.state.openFiles.forEach(f => {
                             if (f === prefixOld || (f.startsWith(prefixOld + '/'))) {
                                 const suffix = f.substring(prefixOld.length);
                                 newOpenFiles.add(prefixNew + suffix);
                             } else {
                                 newOpenFiles.add(f);
                             }
                         });
                         this.state.openFiles = newOpenFiles;
                         
                         if (this.state.activeFile) {
                             if (this.state.activeFile === prefixOld || this.state.activeFile.startsWith(prefixOld + '/')) {
                                 const suffix = this.state.activeFile.substring(prefixOld.length);
                                 this.state.activeFile = prefixNew + suffix;
                             }
                         }
                    };

                    updatePaths(oldPath, newPath);
                    
                    node.name = val;
                    node.isRenaming = false;
                }
                
                this.renderExplorer();
                isCommitting = false;
            };

            input.onkeydown = (e) => { 
                if (e.key === 'Enter') {
                    // Blur will trigger commit, or we call it manually?
                    // Better to blur to ensure consistent behavior
                    input.blur(); 
                }
                e.stopPropagation(); 
            };
            input.onblur = commit;
            input.onclick = (e) => e.stopPropagation();
            
            span.appendChild(input);
            setTimeout(() => input.focus(), 10);
        } else {
            span.innerText = node.name || (node.type === 'folder' ? 'untitled' : 'untitled.py');
        }
        return span;
    },

    // --- STATE MODIFIERS ---

    createNode(type) {
        // Detect target
        // If activeFolder is set and valid, push there. Else root.
        let target = this.state.root;
        
        // Validate activeFolder is still in tree? (Assume yes or it would be null on delete)
        if (this.state.activeFolder) {
            target = this.state.activeFolder;
        }

        const newNode = {
            type: type,
            name: '',
            isRenaming: true,
            children: type === 'folder' ? [] : undefined,
            content: type === 'file' ? '' : undefined,
            lastOutput: null
        };
        
        target.children.push(newNode);
        target.expanded = true; // Ensure visibility
        this.renderExplorer();
    },

    importFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.py'; 
        input.style.display = 'none';
        document.body.appendChild(input);

        input.onchange = (e) => {
            const file = e.target.files[0];
            document.body.removeChild(input);
            if (!file) return;

            if (!file.name.endsWith('.py')) {
                alert("Only Python (.py) files can be imported.");
                return;
            }

            const reader = new FileReader();
            reader.onload = (event) => {
                const content = event.target.result;
                const fileName = file.name;
                
                // Determine target folder
                let target = this.state.root;
                if (this.state.activeFolder) {
                    target = this.state.activeFolder;
                }
                
                // Check for name collision
                let uniqueName = fileName;
                let counter = 1;
                while (target.children.some(c => c.name === uniqueName)) {
                    const extIndex = fileName.lastIndexOf('.');
                    if (extIndex > -1) {
                         const base = fileName.substring(0, extIndex);
                         const ext = fileName.substring(extIndex);
                         uniqueName = `${base} (${counter})${ext}`;
                    } else {
                        uniqueName = `${fileName} (${counter})`;
                    }
                    counter++;
                }
                
                const newNode = {
                    type: 'file',
                    name: uniqueName,
                    isRenaming: false,
                    content: content,
                    lastOutput: null
                };

                target.children.push(newNode);
                
                // Save imported file
                const parentPath = this.findNodePath(target);
                const newPath = parentPath ? `${parentPath}/${uniqueName}` : uniqueName;
                this.saveFileToServer(newPath, content);

                target.expanded = true;
                this.renderExplorer();
            };
            
            reader.readAsText(file);
        };
        
        input.click();
    },

    moveNode(nodeBeingMoved, newParent) {
        // 1. Basic Safety Checks
        if (!nodeBeingMoved || !newParent) return;
        if (nodeBeingMoved === newParent) return; // Can't move into self
        if (newParent.children && newParent.children.includes(nodeBeingMoved)) return; // Already there

        // 2. Prevent moving folder into its own descendant
        if (nodeBeingMoved.type === 'folder' && this.isDescendant(newParent, nodeBeingMoved)) { 
            // Note: isDescendant(parent, node) checks if `node` is in `parent` subtree.
            // We want to check if `newParent` is in `nodeBeingMoved` subtree.
            // So: isDescendant(nodeBeingMoved, newParent) -- Wait, my args were flipped in previous code?
            // Existing code: isDescendant(parent, node). 
            // Call was: isDescendant(nodeBeingMoved, newParent) -> "is newParent inside nodeBeingMoved?" -> Correct.
            console.warn("Cannot move folder into its own subtree.");
            return;
        }

        // 3. Name Collision Check
        if (newParent.children && newParent.children.some(c => c.name === nodeBeingMoved.name && c !== nodeBeingMoved)) {
             alert(`A file or folder named "${nodeBeingMoved.name}" already exists in the destination.`);
             // Cancel the move (dragend will clean up visual state)
             return;
        }

        // Get Old Path (Before Mutating Tree)
        const oldPath = this.findNodePath(nodeBeingMoved);

        // 4. Remove from old parent
        // We need to find the parent first. The recursive `removeNodeFromParent` handles searching.
        // It returns true if found & removed.
        const removed = this.removeNodeFromParent(nodeBeingMoved, this.state.root);
        
        if (removed) {
             // 5. Add to new parent
             if (!newParent.children) newParent.children = [];
             newParent.children.push(nodeBeingMoved);
             
             // Server Sync
             const newParentPath = this.findNodePath(newParent);
             const newPath = newParentPath ? `${newParentPath}/${nodeBeingMoved.name}` : nodeBeingMoved.name;
             
             if (oldPath && newPath) {
                 this.callServer('rename_node', { oldPath, newPath }).then(success => {
                     // If fail, we should arguably revert? But simplistic for now.
                 });
             }

             // 6. Cleanup UI state (since paths changed, editors are invalid)
             this.cleanupMovedNode(nodeBeingMoved);
             
             // 7. Expand new parent
             newParent.expanded = true;
             this.renderExplorer();
        }
    },

    isDescendant(parent, node) {
        if (!parent.children) return false;
        for (const child of parent.children) {
            if (child === node) return true;
            if (child.type === 'folder' && this.isDescendant(child, node)) return true;
        }
        return false;
    },

    removeNodeFromParent(node, parent) {
        if (!parent.children) return false;
        
        const idx = parent.children.indexOf(node);
        if (idx > -1) {
            parent.children.splice(idx, 1);
            return true;
        }
        
        for (const child of parent.children) {
            if (child.type === 'folder') {
               if (this.removeNodeFromParent(node, child)) return true;
            }
        }
        return false;
    },

    cleanupMovedNode(node) {
        // Since paths change, we must close related editors or they will break/duplicate
        // Easiest is to close everything. Robust way is to rename keys but that's complex without back-references.
        // We will just clear dragging state and maybe close open editors?
        // Actually, just clearing activeFile might be enough to prevent errors, but the editors are still in DOM?
        // No, renderExplorer rebuilds DOM. So old editors are gone.
        // But state.openFiles implies we should try to re-open them?
        // If we leave them in state.openFiles, they will try to open with OLD paths (which don't exist)
        // So we should align state.
        
        // Brute force safety:
        this.state.openFiles.clear();
        this.state.activeFile = null;
        this.state.editors = {}; // Reset editor instances
    },

    findParent(targetNode, currentNode) {
        if (!currentNode.children) return null;
        if (currentNode.children.includes(targetNode)) return currentNode;
        
        for (const child of currentNode.children) {
            if (child.type === 'folder') {
                const found = this.findParent(targetNode, child);
                if (found) return found;
            }
        }
        return null;
    },

    deleteNode(nodeToDelete, parentNode) {
        if (!parentNode.children) return false;
        
        const idx = parentNode.children.indexOf(nodeToDelete);
        if (idx > -1) {
            if (confirm(`Delete ${nodeToDelete.name}?`)) {
                // Get path BEFORE removing locally
                const pathToDelete = this.findNodePath(nodeToDelete);
                if (pathToDelete) {
                    this.callServer('delete_node', { path: pathToDelete });
                }

                // Remove Active Folder ref if deleted
                if (this.state.activeFolder === nodeToDelete) {
                    this.state.activeFolder = null;
                }

                // If active file is inside here, clear it
                this.cleanupGeometry(nodeToDelete);
                parentNode.children.splice(idx, 1);
                this.renderExplorer();
            }
            return true;
        }

        for (const child of parentNode.children) {
            if (child.type === 'folder') {
                if (this.deleteNode(nodeToDelete, child)) return true;
            }
        }
        return false;
    },

    cleanupGeometry(node) {
        if (node.type === 'file') {
             // We need the path to clear geometry. 
             // Since we don't track full path in node, we'd need to reconstruct.
             // Simplification: Flush all viewport geometry or iterate objects?
             // App builds paths dynamically. 
             // Ideally we pass path to deleteNode.
             // For now, let's just clear active selection if it matches.
             this.viewport.updateFileGeometry(node.name, []); // This might miss if name is duplicated in folders.
        } else if (node.children) {
            node.children.forEach(c => this.cleanupGeometry(c));
        }
    },

    // --- EDITOR LOGIC ---

    toggleFile(path, node, skipSave = false) {
        if (this.state.openFiles.has(path)) {
            // Close
            this.state.openFiles.delete(path);
            this.viewport.setFileVisibility(path, false);
            if (this.state.activeFile === path) {
                this.state.activeFile = null;
            }
        } else {
            // Open
            this.state.openFiles.add(path);
            this.state.activeFile = path;
            this.viewport.setFileVisibility(path, true);
        }
        this.renderExplorer();
        if (!skipSave) this.saveWorkspaceState();
    },

    findNodeByPath(path) {
        const parts = path.split('/');
        let current = this.state.root;
        
        // Handle root name mismatch or skip if root is implicit
        // Our paths don't include "root" usually.
        for (let i = 0; i < parts.length; i++) {
            if (!current.children) return null;
            const part = parts[i];
            const found = current.children.find(c => c.name === part);
            if (found) {
                current = found;
            } else {
                return null; 
            }
        }
        return current;
    },

    saveWorkspaceState() {
        if (!this.state.currentProjectName) return;
        
        // Debounce
        if (this._saveWorkspaceTimeout) clearTimeout(this._saveWorkspaceTimeout);
        this._saveWorkspaceTimeout = setTimeout(() => {
            const openFiles = Array.from(this.state.openFiles);
            const activeFile = this.state.activeFile;
            
            // Collect Node States (Open files data, Expanded folders)
            const nodeStates = {};
            
            const traverse = (node, path) => {
                 if (node.type === 'folder') {
                     if (node.expanded) nodeStates[path] = { expanded: true };
                     if (node.children) node.children.forEach(c => traverse(c, path ? `${path}/${c.name}` : c.name));
                 } else { // File
                     if (this.state.openFiles.has(path)) {
                         nodeStates[path] = {
                             editorHeight: node.editorHeight,
                             isLive: node.isLive,
                             lastOutput: node.lastOutput ? (typeof node.lastOutput === 'string' && node.lastOutput.length > 5000 ? node.lastOutput.substring(0,5000) + '...' : node.lastOutput) : null
                         };
                     }
                 }
            };
            
            if (this.state.root && this.state.root.children) {
                this.state.root.children.forEach(c => traverse(c, c.name));
            }

            // Collect UI State
            const splitter = document.getElementById('left-panel');
            const uiState = {
                splitterWidth: splitter ? splitter.style.width : null,
                activeFolder: this.state.activeFolder ? this.findNodePath(this.state.activeFolder) : null
            };
            
            fetch(`/project/${encodeURIComponent(this.state.currentProjectName)}/workspace`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ openFiles, activeFile, nodeStates, uiState })
            }).catch(e => console.error("Failed to save workspace state", e));
        }, 1000);
    },

    renderEditorIn(container, node, path) {
        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'editor-toolbar';
        toolbar.style.justifyContent = 'space-between'; // Override to spread items
        
        // Right Group for Run and Live
        const rightGroup = document.createElement('div');
        rightGroup.style.display = 'flex';
        rightGroup.style.alignItems = 'center';
        rightGroup.style.gap = '10px';

        // Run Button
        const runBtn = document.createElement('button');
        runBtn.className = 'run-btn';
        runBtn.innerText = 'Run';
        runBtn.onclick = () => this.runCode(path, node);
        
        // Live Toggle
        const liveLabel = document.createElement('label');
        // liveLabel.style.marginLeft = '10px'; // Handled by gap
        liveLabel.style.fontSize = '12px';
        liveLabel.style.color = '#666';
        liveLabel.style.display = 'flex';
        liveLabel.style.alignItems = 'center';
        liveLabel.style.cursor = 'pointer';
        liveLabel.title = "Run code automatically after typing stops";

        const liveInput = document.createElement('input');
        liveInput.type = 'checkbox';
        liveInput.checked = !!node.isLive;
        liveInput.style.marginRight = '5px';
        liveInput.onchange = (e) => {
            node.isLive = e.target.checked;
            this.saveWorkspaceState();
        };

        liveLabel.append(liveInput, document.createTextNode("Live"));
        
        // Add to Right Group
        rightGroup.append(runBtn, liveLabel);

        // Export OBJ Button (Left Side)
        const exportBtn = document.createElement('button');
        exportBtn.innerText = 'Export OBJ';
        exportBtn.className = 'run-btn'; 
        // exportBtn.style.marginLeft = '10px';
        exportBtn.style.background = '#e0e0e0'; // Neutral light gray
        exportBtn.style.border = '1px solid #ccc';
        exportBtn.style.padding = '5px 10px';
        exportBtn.style.color = '#333';
        exportBtn.style.cursor = 'pointer';
        
        exportBtn.onclick = () => {
             if (!this.viewport) {
                 this.showNotification("Viewport not initialized", 'error');
                 return;
             }
             const objData = this.viewport.exportToOBJ(path);
             if (objData) {
                 const blob = new Blob([objData], { type: 'text/plain' });
                 const url = URL.createObjectURL(blob);
                 const a = document.createElement('a');
                 a.href = url;
                 // Use file name without logic if possible, or append .obj
                 const baseName = node.name.lastIndexOf('.') !== -1 ? node.name.substring(0, node.name.lastIndexOf('.')) : node.name;
                 a.download = `${baseName}_geometry.obj`;
                 document.body.appendChild(a);
                 a.click();
                 document.body.removeChild(a);
                 URL.revokeObjectURL(url);
                 
                 this.showNotification(`Exported ${baseName}_geometry.obj`, 'success');
             } else {
                 this.showNotification("No geometry found. Run the code first.", 'warning');
             }
        };

        toolbar.append(exportBtn, rightGroup);

        // Host
        const monacoHost = document.createElement('div');
        monacoHost.className = 'monaco-host';
        const initialHeight = node.editorHeight || 200;
        monacoHost.style.height = `${initialHeight}px`;

        // Create Resizer Element (Handle)
        const resizer = document.createElement('div');
        resizer.className = 'editor-resizer';
        resizer.title = 'Drag to Resize';
        // Inline styles for visibility
        resizer.style.height = '6px';
        resizer.style.width = '100%';
        resizer.style.cursor = 'ns-resize';
        resizer.style.background = '#e0e0e0'; // Visible bar
        resizer.style.borderTop = '1px solid #bbb';
        resizer.style.borderBottom = '1px solid #bbb';
        
        // Add events
        const doDrag = (e) => {
           const currentY = e.clientY;
           if (!this.resizerState) return;
           const newH = this.resizerState.startH + (currentY - this.resizerState.startY);
           if (newH > 50) {
               monacoHost.style.height = `${newH}px`;
               node.editorHeight = newH; // Persist
               if (this.state.editors[path]) this.state.editors[path].layout();
           }
        };
        const stopDrag = () => {
            document.removeEventListener('mousemove', doDrag);
            document.removeEventListener('mouseup', stopDrag);
            document.body.style.cursor = 'default';
            this.resizerState = null;
            this.saveWorkspaceState();
        };

        resizer.onmousedown = (e) => {
            e.preventDefault();
            this.resizerState = {
                startY: e.clientY,
                startH: monacoHost.offsetHeight
            };
            document.body.style.cursor = 'ns-resize';
            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', stopDrag);
        };
        
        // Output
        const output = document.createElement('div');
        output.className = 'file-output';
        const safeId = path.replace(/[^a-zA-Z0-9]/g, '_');
        output.id = `output-${safeId}`;
        output.innerText = node.lastOutput || "Output will appear here...";
        if (node.lastOutput && !node.lastOutput.includes('Error')) output.classList.add('success');
        
        container.append(toolbar, monacoHost, resizer, output);

        // Monaco Init
        // We delay slightly to ensure DOM is in tree
        setTimeout(() => {
            // Check if existing editor for this path needs disposal?
            if (this.state.editors[path]) {
                const old = this.state.editors[path];
                // If the model is the same, we might be able to detach/attach? 
                // But full recreation is safer for "simple" logic.
                old.dispose();
            }

            const editor = monaco.editor.create(monacoHost, {
                value: node.content,
                language: 'python',
                theme: 'vs',
                automaticLayout: true, // handles container resize from other sources?
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                scrollbar: { alwaysConsumeMouseWheel: false }
            });
            
            // AI Action (Cmd+I)
            editor.addAction({
                id: 'ask-ai',
                label: 'Ask AI (Generate Code)',
                keybindings: [
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI
                ],
                contextMenuGroupId: 'navigation',
                contextMenuOrder: 0,
                run: (ed) => {
                    this.showAIInput(ed);
                }
            });

            // NO Auto-Size: We now rely on user drag.
            // But we start with default 200px or persisted height.

            // Decorators / Widgets Store
            let activeWidgets = [];

            // Setup Live Coding Debounce (Moved up for widget access)
            let debounceTimer = null;

            // Helper to parsing sliders
            const updateWidgets = () => {
                // Clear old widgets
                activeWidgets.forEach(w => editor.removeContentWidget(w));
                activeWidgets = [];

                const model = editor.getModel();
                if (!model) return;

                const lines = model.getLinesContent();
                const regexRange = /([a-zA-Z0-9_]+)\s*=\s*([-+]?[0-9]*\.?[0-9]+)\s*#\s*range\(\s*([-+]?[0-9]*\.?[0-9]+)\s*,\s*([-+]?[0-9]*\.?[0-9]+)\s*\)/g;
                const regexSwitch = /([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*#\s*switch\s*\((.+)\)/g;

                lines.forEach((line, index) => {
                    // --- SLIDERS ---
                    let match;
                    while ((match = regexRange.exec(line)) !== null) {
                        const varName = match[1];
                        const currentValue = parseFloat(match[2]);
                        const min = parseFloat(match[3]);
                        const max = parseFloat(match[4]);
                        
                        const widgetId = `slider-${index}-${match.index}`;
                        const widgetDom = document.createElement('div');
                        widgetDom.style.background = '#f5f5f5';
                        widgetDom.style.border = '1px solid #ccc';
                        widgetDom.style.padding = '2px 5px';
                        widgetDom.style.borderRadius = '3px';
                        widgetDom.style.display = 'flex';
                        widgetDom.style.alignItems = 'center';
                        widgetDom.style.zIndex = '100';

                        const rangeInput = document.createElement('input');
                        rangeInput.type = 'range';
                        rangeInput.min = min;
                        rangeInput.max = max;
                        rangeInput.step = (max - min) / 100;
                        if (currentValue % 1 === 0 && min % 1 === 0 && max % 1 === 0) rangeInput.step = 1; 
                        rangeInput.value = currentValue;
                        rangeInput.style.width = '100px';
                        rangeInput.style.margin = '0';
                        rangeInput.onmousedown = (e) => e.stopPropagation();

                        rangeInput.oninput = (e) => {
                            if (debounceTimer) clearTimeout(debounceTimer);

                            const val = parseFloat(e.target.value);
                            const currentLine = model.getLineContent(index + 1);
                            const currentMatch = /([a-zA-Z0-9_]+)\s*=\s*([-+]?[0-9]*\.?[0-9]+)(\s*#\s*range\(\s*[-+]?[0-9]*\.?[0-9]+\s*,\s*[-+]?[0-9]*\.?[0-9]+\s*\))/.exec(currentLine);

                            if (currentMatch) {
                                const newValueStr = val % 1 === 0 ? val.toFixed(0) : val.toFixed(2);
                                const fullMatchStart = currentLine.indexOf(currentMatch[0]);
                                const valIndexInMatch = currentMatch[0].indexOf(currentMatch[2], currentMatch[1].length + 1); 
                                const valStartCol = fullMatchStart + valIndexInMatch + 1;
                                const valEndCol = valStartCol + currentMatch[2].length;
                                
                                const range = new monaco.Range(index + 1, valStartCol, index + 1, valEndCol);
                                
                                editor.executeEdits('slider', [{
                                    range: range,
                                    text: newValueStr,
                                    forceMoveMarkers: true
                                }]);
                                
                                this.runCode(path, node);
                            }
                        };

                        widgetDom.appendChild(rangeInput);
                        
                        const myLine = index + 1;
                        const myCol = match.index + match[0].length + 1;
                        
                        const widget = {
                            getId: () => widgetId,
                            getDomNode: () => widgetDom,
                            getPosition: () => ({
                                position: { lineNumber: myLine, column: myCol },
                                preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
                            })
                        };

                        editor.addContentWidget(widget);
                        activeWidgets.push(widget);
                    }

                    // --- SWITCHES ---
                    let sMatch;
                    while ((sMatch = regexSwitch.exec(line)) !== null) {
                        const varName = sMatch[1];
                        const rawVal = sMatch[2].trim();
                        // Handle simple values, no complex expressions ideally. 
                        // If string, likely 'val'. If number, 123. If var, varname.
                        
                        // Parse options
                        // Improved parsing to handle quotes more robustly?
                        // If user writes: # switch('a', 'b')
                        // optionsStr is "'a', 'b'"
                        // split gives ["'a'", "'b'"]
                        // rawVal from regex group 2 might be "'a'" (including quotes) if the regex is greedy/lazy enough.
                        // Regex was: /([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*#\s*switch\s*\((.+)\)/
                        // Group 2 (.+?) matches value.
                        
                        const optionsStr = sMatch[3];
                        const options = optionsStr.split(',').map(s => s.trim());
                        
                        // normalize check
                        let currentIdx = options.indexOf(rawVal);
                        
                        // Fallback: try matching without quotes if not found?
                        if (currentIdx === -1) {
                            // Try stripping quotes from rawVal and options
                            const strip = s => s.replace(/^['"]|['"]$/g, '');
                            const rawStripped = strip(rawVal);
                            const optionsStripped = options.map(strip);
                            currentIdx = optionsStripped.indexOf(rawStripped);
                        }
                        
                        const widgetId = `switch-${index}-${sMatch.index}`;
                        const widgetDom = document.createElement('div');
                        // Use flexbox again but strictly controlled
                        widgetDom.style.display = 'inline-flex'; // Changed to inline-flex
                        widgetDom.style.flexDirection = 'row';
                        widgetDom.style.alignItems = 'center';
                        widgetDom.style.justifyContent = 'center'; // Center everything
                        widgetDom.style.position = 'relative'; // Anchor for absolute children
                        
                        widgetDom.style.background = '#f5f5f5';
                        widgetDom.style.border = '1px solid #ccc';
                        widgetDom.style.borderRadius = '3px';
                        widgetDom.style.fontSize = '12px'; 
                        widgetDom.style.color = '#333';
                        widgetDom.style.height = '20px'; 
                        widgetDom.style.lineHeight = '20px';
                        widgetDom.style.width = 'auto'; 
                        widgetDom.style.minWidth = 'fit-content'; // Ensure fit
                        widgetDom.style.boxSizing = 'border-box';
                        // widgetDom.style.position = 'absolute';
                        widgetDom.onmousedown = (e) => e.stopPropagation();

                        const createBtn = (text, dir) => {
                             const btn = document.createElement('span');
                             btn.innerText = text;
                             btn.style.display = 'inline-flex'; // Flex to center content
                             btn.style.alignItems = 'center';
                             btn.style.justifyContent = 'center';
                             btn.style.width = '20px'; 
                             btn.style.height = '100%'; 
                             btn.style.cursor = 'pointer';
                             btn.style.background = '#eee';
                             btn.style.userSelect = 'none';
                             btn.style.flexShrink = '0'; 
                             btn.style.boxSizing = 'border-box';
                             btn.style.padding = '0'; // Ensure no padding upsets alignment
                             btn.style.margin = '0';
                             btn.style.position = 'absolute';
                             // Borders & Position
                             if(dir === -1) {
                                 btn.style.borderRight = '1px solid #ccc';
                                 btn.style.left = '0';
                             }
                             if(dir === 1) {
                                 btn.style.borderLeft = '1px solid #ccc';
                                 btn.style.right = '0';
                             }

                             btn.onmouseover = () => btn.style.background = '#ddd';
                             btn.onmouseout = () => btn.style.background = '#eee';
                             btn.onclick = () => {
                                 // Get Fresh Value from Model
                                 const currentLine = model.getLineContent(index + 1);
                                 const freshMatch = /([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*#\s*switch\s*\((.+)\)/.exec(currentLine);
                                 
                                 if (!freshMatch) return;

                                 const currentValInText = freshMatch[2].trim();
                                 let validIdx = options.indexOf(currentValInText);
                                 
                                 if (validIdx === -1) {
                                     // Try stripped quotes
                                     const strip = s => s.replace(/^['"]|['"]$/g, '');
                                     const rawStripped = strip(currentValInText);
                                     const optionsStripped = options.map(strip);
                                     validIdx = optionsStripped.indexOf(rawStripped);
                                 }

                                 if (validIdx === -1) validIdx = 0; // Default if completely lost
                                 
                                 // Calculate next index with wrap-around
                                 let nextIdx = (validIdx + dir);
                                 if (nextIdx < 0) nextIdx = options.length - 1;
                                 if (nextIdx >= options.length) nextIdx = 0;
                                 
                                 const newVal = options[nextIdx];
                                 
                                 // Replace in text
                                 const fullMatchStart = currentLine.indexOf(freshMatch[0]);
                                 const p1 = freshMatch[1];
                                 const p2 = freshMatch[2]; // Current value in text
                                 
                                 const valIndexInMatch = freshMatch[0].indexOf(p2, p1.length + 1);
                                 const valStartCol = fullMatchStart + valIndexInMatch + 1;
                                 const valEndCol = valStartCol + p2.length;
                                 
                                 const range = new monaco.Range(index + 1, valStartCol, index + 1, valEndCol);
                                 
                                 editor.executeEdits('switch-click', [{ 
                                    range: range,
                                    text: newVal,
                                    forceMoveMarkers: true
                                 }]);
                                 if (debounceTimer) clearTimeout(debounceTimer);
                                 this.runCode(path, node);
                             };
                             return btn;
                        };

                        const label = document.createElement('span');
                        label.style.display = 'inline-block';

                        // Fix label display to prioritize rawVal but handle missing case gracefully
                        let displayVal = rawVal;
                        if (currentIdx === -1) displayVal = '?';
                        
                        label.innerText = displayVal;
                        label.style.width = '100%';
                        label.style.paddingLeft = '20px';
                        label.style.paddingRight = '20px';
                        label.style.boxSizing = 'border-box';
                        label.style.textAlign = 'center';
                        // label.style.position = 'absolute';
                        label.style.overflow = 'hidden';
                        label.style.textOverflow = 'ellipsis';
                        label.style.whiteSpace = 'nowrap';
                        label.title = `Current Value: ${rawVal}`;
                        label.style.flexGrow = '1'; // Fill remaining space
                        label.style.minWidth = '20px'; // Prevent collapse
                        
                        // Calculate desired width based on text length
                        // But rely on flexbox to constrain it if necessary
                        const maxChars = options.reduce((max, opt) => Math.max(max, opt.length), 0);
                        const labelWidth = Math.max(40, maxChars * 8 + 10); 
                        const arrowWidth = 20;
                        const totalWidth = (labelWidth) + (arrowWidth * 2);

                        // We set width on the parent WIDGET to ensure it reserves space for everything
                        widgetDom.style.width = `${totalWidth}px`;
                        // label is 100% width with padding for buttons
 

                        widgetDom.appendChild(createBtn('\u25C0', -1)); 
                        widgetDom.appendChild(label);
                        widgetDom.appendChild(createBtn('\u25B6', 1));  

                        const myLine = index + 1;
                        const myCol = sMatch.index + sMatch[0].length + 1; // End of the full match?
                        // The regex matches everything `var = val # switch(...)`. 
                        // So the widget is placed *after* the closing parenthesis.
                        
                        // User mentioned: "arrows should be on either side of the variable name... not above and below".
                        // Wait, if they are seeing arrows above/below, maybe flex-direction is column? No, default is row.
                        // Or maybe `label` text is wrapping? I added `whiteSpace: nowrap`.
                        
                        // What if they want the widget TO REPLACE the value in the code visually? 
                        // "it's a box with a variable name in it... click on arrow... shows variable coming next"
                        // "arrows should be on either side of the variable name"
                        // This describes my widget: [ < ] [ value ] [ > ]
                        
                        // Maybe they mean position relative to code? "not above and below [the variable name]".
                        // If I place it at the end of the line, it is "side by side" with the code.
                        // If they see it above/below, maybe they have word wrap?
                        
                        const widget = {
                            getId: () => widgetId,
                            getDomNode: () => widgetDom,
                            getPosition: () => ({
                                position: { lineNumber: myLine, column: myCol },
                                preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
                            })
                        };

                        editor.addContentWidget(widget);
                        activeWidgets.push(widget);
                    }
                });
            };

            // Run initial slider scan
            updateWidgets();

            editor.onDidChangeModelContent((e) => {
                const currentContent = editor.getValue();
                node.content = currentContent;
                
                // --- Real-time Collaboration ---
                if (!this.isRemoteUpdate && this.socket && this.state.currentProjectName) {
                    this.socket.emit('code_change', {
                        project: this.state.currentProjectName,
                        filename: path,
                        content: currentContent, // Full content for consistency
                        changes: e.changes       // Delta for smooth updates
                    });
                }

                // --- Simple Autosave ---
                if (this.state.currentProjectName) {
                    // Debounce save?
                    if (node.saveTimeout) clearTimeout(node.saveTimeout);
                    node.saveTimeout = setTimeout(() => {
                        this.saveFileToServer(path, currentContent);
                    }, 1000); // Save 1s after last edit
                }
                
                // Don't rebuild sliders if the change came from a slider interaction?
                // The slider interaction updates value. The value update triggers this.
                // Re-parsing every keystroke is fine for small files.
                // But if we rebuild widget, we lose focus/drag state of the slider!
                // We must detect if change came from slider?
                // Or just don't rebuild if the line structure regarding comments hasn't changed?
                
                // Simple fix: If change is 'slider', don't full rebuild?
                if (e.changes.some(c => c.text.match(/^[-+]?[0-9]*\.?[0-9]+$/))) {
                    // Update: Actually we DO need to update because if we dragged, the text changed.
                    // But if we remove/add widget, the drag stops. 
                    // We must find existing widget and update its value without replacing DOM.
                    // OR: rely on the fact that if we don't call updateSliders(), the widget stays.
                    // But we need to updateSliders() when user TYPES a new range comment.
                    
                    // We can debounce the slider update?
                    // But if we type `# range..` we want it to appear.
                }

                // If event is just a value change on an existing slider line, we should avoid re-render.
                // However, detecting "just a value change" is tricky.
                
                // Let's debounce the slider UI update too?
                // But dragging needs 60fps updates to *code*, code updates trigger this event.
                // If we debounce UI rebuild, maybe the drag persists?
                
                // Let's try: only call updateSliders if the number of sliders or their definitions changed?
                // Or just rebuild. If drag breaks, we fix.
                // (Spoiler: Rebuilding DOES break drag).
                
                // To fix drag breaking:
                // We check if the change was triggered by our specific slider edit?
                // Monaco doesn't pass 'source' easily unless we tracked it.
                // We used `executeEdits('slider', ...)`
                
                // Check if last edit was 'slider' (tracked via internal flag?)
                if (!editor._isSliderMoving) {
                     updateWidgets();
                }
                
                if (node.isLive) {
                    if (debounceTimer) clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        this.runCode(path, node);
                    }, 800); // 800ms pause
                }
            });

            // Monkey-patch executeEdits to track source?
            const originalExecuteEdits = editor.executeEdits;
            editor.executeEdits = function(source, edits, endCursorState) {
                if (source === 'slider') {
                    editor._isSliderMoving = true;
                    // Reset flag after event loop or short timeout?
                    // Actually onDidChangeModelContent fires synchronously usually?
                    // Let's just set a timeout to clear it
                    setTimeout(() => { editor._isSliderMoving = false; }, 50);
                }
                return originalExecuteEdits.apply(this, arguments);
            };
            
            // Clean up widgets on dispose
            const originalDispose = editor.dispose;
            editor.dispose = function() {
                activeWidgets.forEach(w => {
                    // editor.removeContentWidget(w) // this might already be gone
                });
                originalDispose.apply(this, arguments);
            };
            
            // Track active file for viewport insertion
            editor.onDidFocusEditorText(() => {
                 this.state.activeFile = path; 
                 this.saveWorkspaceState();
            });
            
            this.state.editors[path] = editor;
        }, 50); // Increased timeout slightly to ensure DOM insertion
    },

    async runCode(path, node) {
        // Serialization: Prevent overlapping runs
        if (node.isRunning) {
            node.pendingRun = true;
            return;
        }
        node.isRunning = true;

        const editor = this.state.editors[path];
        if (!editor) {
            node.isRunning = false;
            return;
        }

        const safeId = path.replace(/[^a-zA-Z0-9]/g, '_');
        const outElem = document.getElementById(`output-${safeId}`);
        if(outElem) {
            outElem.innerText = '[Running...]';
            outElem.className = 'file-output';
        }

        const code = editor.getValue();

        // New Logic: Find "imports.py" automatically
        let importsCode = "";
        const findImportsFile = (n) => {
             // Look explicitly for file named "imports.py" in root for now, or traverse?
             // Simple traversal
             if (n.name === 'imports.py' && n.type === 'file') return n;
             if (n.children) {
                 for (let c of n.children) {
                     const f = findImportsFile(c);
                     if (f) return f;
                 }
             }
             return null;
        }

        const importsNode = findImportsFile(this.state.root);
        if (importsNode) {
            // console.log("Found imports.py, injecting content...");
            importsCode = importsNode.content || "";
        } else {
            // console.log("No imports.py found.");
        }

        try {
            const response = await fetch('/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    filename: path, 
                    code, 
                    pre_import_code: importsCode,
                    project: this.state.currentProjectName // Isolate execution scope
                })
            });

            const data = await response.json();

            // Handle Output
            let outText = data.output || "";
            
            if (data.error) {
                outText += `\n[Error]\n${data.error}`;
                if (outElem) outElem.classList.add('error');
            } else {
                 if (outElem) outElem.classList.add('success');
            }
            
            // Persist output state
            node.lastOutput = outText;
            if (outElem) outElem.innerText = outText || "[No output]";
            
            // Update 3D View
            if (this.viewport) {
                this.viewport.updateFileGeometry(path, data.geometry || []);
            }

        } catch (err) {
            if (outElem) {
                outElem.classList.add('error');
                outElem.innerText = `[Fetch Error]: ${err.message}`;
            }
        } finally {
            node.isRunning = false;
            if (node.pendingRun) {
                node.pendingRun = false;
                this.runCode(path, node);
            }
        }
    },

    // Window Setup for Splitter is already in init() -> setupSplitter()

    setupSplitter() {
        const splitter = document.getElementById('splitter');
        const leftPanel = document.getElementById('left-panel');
        let isDragging = false;

        if (!splitter || !leftPanel) return;

        splitter.onmousedown = (e) => {
            isDragging = true;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        };

        document.onmousemove = (e) => {
            if (!isDragging) return;
            
            // Calculate width based on mouse position relative to left panel's start
            const offset = leftPanel.getBoundingClientRect().left;
            const w = e.clientX - offset;
            
            if (w > 150 && w < window.innerWidth - 100) {
                leftPanel.style.width = `${w}px`;
                this.viewport.onWindowResize();
            }
        };

        document.onmouseup = () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.cursor = 'default';
                this.saveWorkspaceState();
                this.viewport.onWindowResize();
            }
        };
    },

    onViewportSelection(name) {
        if (!this.state.activeFile) return;
        
        // Find which editor is active. 
        // Logic: activeFile is the path.
        const editor = this.state.editors[this.state.activeFile];
        if (editor) {
            const pos = editor.getPosition();
            // Append name at cursor or end
            const text = name; // Just the name for now
            
            // Determine edit operation
            const selection = editor.getSelection();
            const op = {
                range: selection,
                text: text,
                forceMoveMarkers: true
            };
            editor.executeEdits("viewport-click", [op]);
            editor.focus();
        }
    },
    
    // --- File IO Helpers ---
    downloadFile(node) {
        if (!node.content) return;
        const blob = new Blob([node.content], { type: 'text/x-python' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = node.name.endsWith('.py') ? node.name : node.name + '.py';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showNotification(`Downloaded ${node.name}`, 'success');
    },

    async saveFileAs(node) {
        if (!window.showSaveFilePicker) {
            // alert("Your browser does not support 'Save As'. Downloading instead.");
            this.showNotification("Browser doesn't support Save As. Downloading...", 'warning');
            this.downloadFile(node);
            return;
        }
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: node.name,
                types: [{
                    description: 'Python File',
                    accept: { 'text/x-python': ['.py'] },
                }],
            });
            const writable = await handle.createWritable();
            await writable.write(node.content);
            await writable.close();
            this.showNotification(`Saved ${node.name}`, 'success');
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error(err);
                this.showNotification(`Save Failed: ${err.message}`, 'error');
            }
        }
    },

    showNotification(message, type = 'info') {
        let container = document.getElementById('notification-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'notification-container';
            container.style.position = 'fixed';
            container.style.bottom = '20px';
            container.style.right = '20px';
            container.style.zIndex = '1000';
            container.style.display = 'flex';
            container.style.flexDirection = 'column';
            container.style.gap = '10px';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.innerText = message;
        toast.style.padding = '12px 20px';
        toast.style.borderRadius = '4px';
        toast.style.color = '#fff';
        toast.style.boxShadow = '0 2px 10px rgba(0,0,0,0.3)';
        toast.style.fontFamily = 'sans-serif';
        toast.style.fontSize = '14px';
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s ease';
        toast.style.minWidth = '200px';

        // Colors
        if (type === 'success') toast.style.background = '#4CAF50';
        else if (type === 'error') toast.style.background = '#F44336';
        else if (type === 'warning') toast.style.background = '#FF9800';
        else toast.style.background = '#2196F3'; // info

        container.appendChild(toast);
        
        // Animate In
        requestAnimationFrame(() => {
            toast.style.opacity = '1';
        });

        // Remove after 3s
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => {
                if (container.contains(toast)) container.removeChild(toast);
            }, 300);
        }, 3000);
    }
};

// --- AI EXTENSIONS ---

App.showAIInput = function(editor) {
    if (this._aiWidget) {
        editor.removeContentWidget(this._aiWidget);
        this._aiWidget = null;
        return;
    }
    
    const position = editor.getPosition();
    const domNode = document.createElement('div');
    domNode.className = 'ai-widget';
    domNode.style.background = '#ffffff';
    domNode.style.border = '1px solid #007acc';
    domNode.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    domNode.style.padding = '8px';
    domNode.style.borderRadius = '4px';
    domNode.style.width = '320px';
    domNode.style.display = 'flex';
    domNode.style.flexDirection = 'column';
    
    const label = document.createElement('div');
    label.innerText = '✨ AI Assistant';
    label.style.fontSize = '11px';
    label.style.fontWeight = 'bold';
    label.style.color = '#007acc';
    label.style.marginBottom = '5px';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Ask AI to generate code...';
    input.style.width = '100%';
    input.style.padding = '5px';
    input.style.border = '1px solid #ccc';
    input.style.borderRadius = '2px';
    input.style.marginBottom = '5px';
    input.style.boxSizing = 'border-box';
    
    // Focus after render
    setTimeout(() => input.focus(), 50);

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.gap = '5px';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.innerText = 'Cancel';
    cancelBtn.style.padding = '4px 8px';
    cancelBtn.style.background = '#f0f0f0';
    cancelBtn.style.border = '1px solid #ccc';
    cancelBtn.style.borderRadius = '2px';
    cancelBtn.style.cursor = 'pointer';
    cancelBtn.onclick = () => this.closeAIWidget(editor);
    
    const submitBtn = document.createElement('button');
    submitBtn.innerText = 'Generate';
    submitBtn.style.padding = '4px 8px';
    submitBtn.style.background = '#007acc';
    submitBtn.style.color = 'white';
    submitBtn.style.border = 'none';
    submitBtn.style.borderRadius = '2px';
    submitBtn.style.cursor = 'pointer';
    submitBtn.onclick = () => this.runAICode(editor, input.value);
    
    input.onkeydown = (e) => {
        if (e.key === 'Enter') this.runAICode(editor, input.value);
        if (e.key === 'Escape') this.closeAIWidget(editor);
    };

    btnRow.append(cancelBtn, submitBtn);
    domNode.append(label, input, btnRow);

    const widget = {
        getId: () => 'ai.input.widget',
        getDomNode: () => domNode,
        getPosition: () => {
            return {
                position: position,
                preference: [monaco.editor.ContentWidgetPositionPreference.BELOW]
            };
        }
    };

    this._aiWidget = widget;
    editor.addContentWidget(widget);
};

App.closeAIWidget = function(editor) {
    if (this._aiWidget) {
        editor.removeContentWidget(this._aiWidget);
        this._aiWidget = null;
    }
};

App.runAICode = async function(editor, prompt) {
    if (!prompt) return;
    
    this.closeAIWidget(editor);
    this.showNotification("Asking AI...", 'info');
    
    const model = editor.getModel();
    const selection = editor.getSelection();
    const context = model.getValue();
    const selectedText = model.getValueInRange(selection);
    
    try {
        const response = await fetch('/api/ai_edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt, context, selection: selectedText })
        });
        
        const data = await response.json();
        
        if (data.code) {
             // Insert at cursor or replace selection
             const p = editor.getPosition();
             // If there is a selection, we replace it.
             // If not, we insert at cursor.
             
             let range = selection;
             if (selection.isEmpty()) {
                 range = new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column);
             }
             
             editor.executeEdits('ai-edit', [{
                 range: range,
                 text: data.code,
                 forceMoveMarkers: true
             }]);
             
             this.showNotification("AI Generation Complete", 'success');
        } else {
             this.showNotification("AI returned no code", 'warning');
        }
    } catch (e) {
        console.error(e);
        this.showNotification("AI Error: " + e.message, 'error');
    }
};

// Start
require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.34.0/min/vs' }});
App.monacoPromise = new Promise((resolve) => {
    require(['vs/editor/editor.main'], function() {
        resolve();
    });
});