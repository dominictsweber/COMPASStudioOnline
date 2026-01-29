// frontend/app.js

console.log("🔄 app.js STARTING");


const MAX_VISIBLE_LINES = 5;
const LINE_LIFETIME_MS = 3000;

console.log("🔄 Constants defined");

class CompasWebViewport {
    constructor() {

        console.log("🔄 CompasWebViewport constructor called"); // DEBUG
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.meshes = new Map(); // Store Three.js meshes by GUID
        this.commandHistory = [];
        this.historyIndex = -1;

        this.isLayoutMode = false;
        this.layoutMesh = null;
        
        console.log("🔄 Calling init...");
        this.init();
        console.log("🔄 Calling setupTerminal...");
        this.setupTerminal();
        console.log("🔄 Calling loadCurrentGeometry...");
        this.loadCurrentGeometry();

        // const MAX_VISIBLE_LINES = 5;
        // const LINE_LIFETIME_MS = 3000;
    }
    

    init() {
        // Create Three.js scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf0f0f0);

        // test cube
        // const testGeometry = new THREE.BoxGeometry(1, 1, 1);
        // const testMaterial = new THREE.MeshPhongMaterial({ color: 0xff0000 });
        // const testCube = new THREE.Mesh(testGeometry, testMaterial);
        // testCube.position.set(0, 0, 0);
        // this.scene.add(testCube);
        
        // Create camera
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.set(5, 5, 5);
        this.camera.lookAt(0, 0, 0);
        
        // Create renderer
        const viewport = document.getElementById('viewport');
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(viewport.clientWidth, viewport.clientHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        viewport.appendChild(this.renderer.domElement);
        
        // Add lights
        const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        this.scene.add(ambientLight);
        
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(10, 10, 5);
        this.scene.add(directionalLight);
        
        // Add grid helper
        const gridHelper = new THREE.GridHelper(20, 20, 0x444444, 0x222222);
        gridHelper.name = 'gridHelper';  // ← Add name
        this.scene.add(gridHelper);
        
        // Add axes helper
        const axesHelper = new THREE.AxesHelper(3);
        axesHelper.name = 'axesHelper';  // ← Add name
        this.scene.add(axesHelper);
        
        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());
        
        // Setup controls
        this.setupControls();
        
        // Start animation loop
        this.animate();
        
        // layout
        this.createLayoutPlane();
        this.setupViewModeToggle();

    }
    
    setupControls() {
        let isMouseDown = false;
        let previousMousePosition = { x: 0, y: 0 };
        
        this.renderer.domElement.addEventListener('mousedown', (e) => {
            isMouseDown = true;
            previousMousePosition = { x: e.offsetX, y: e.offsetY };
        });
        
        this.renderer.domElement.addEventListener('mouseup', () => {
            isMouseDown = false;
        });
        
        this.renderer.domElement.addEventListener('mousemove', (e) => {
            if (!isMouseDown) return;
            
            const deltaMove = {
                x: e.offsetX - previousMousePosition.x,
                y: e.offsetY - previousMousePosition.y
            };
            
            // Improved orbit controls
            this.camera.position.x -= deltaMove.x * 0.01;
            this.camera.position.y += deltaMove.y * 0.01;
            this.camera.lookAt(0, 0, 0);
            
            previousMousePosition = { x: e.offsetX, y: e.offsetY };
        });
        
        this.renderer.domElement.addEventListener('wheel', (e) => {
            this.camera.position.multiplyScalar(1 + e.deltaY * 0.001);
        });
    }
    
    setupTerminal() {
        const terminalInput = document.getElementById('terminal-input');
        const terminal = document.getElementById('terminal');
        
        // Clear any existing content
        terminal.innerHTML = '';

        // Welcome message (will auto-remove)
        this.addEphemeralMessage('COMPAS Web Viewport ready.', 'output', 2000);
        this.addEphemeralMessage('Type Python code → geometry appears automatically.', 'output', 2500);
        this.addEphemeralMessage('Text disappears after 3 seconds.', 'output', 2500);
        
        terminalInput.addEventListener('keydown', (e) => {
            console.log("Key pressed:", e.key);

            if (e.key === 'Enter') {
                e.preventDefault();
                const code = terminalInput.value.trim();
                console.log("Executing code:", code);
                
                if (code) {
                    this.executePythonCodeEphemeral(code);
                    terminalInput.value = '';
                    this.historyIndex = this.commandHistory.length;
                }
            }

            // Command history with up/down arrows
            else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.commandHistory.length > 0) {
                    this.historyIndex = Math.max(this.historyIndex - 1, 0);
                    terminalInput.value = this.commandHistory[this.historyIndex] || '';
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.commandHistory.length > 0) {
                    this.historyIndex = Math.min(this.historyIndex + 1, this.commandHistory.length - 1);
                    terminalInput.value = this.commandHistory[this.historyIndex] || '';
                }
            }

        });
        
        // Focus on input
        terminalInput.focus();

        document.addEventListener('keydown', (e) => {
            const terminalInput = document.getElementById('terminal-input');
            if (terminalInput && document.activeElement === terminalInput && e.key === 'Enter') {
                const code = terminalInput.value.trim();
                if (code) {
                    this.executePythonCode(code);
                    terminalInput.value = '';
                }
            }
        });
    }
    
    // Ephemeral version of executePythonCode
    async executePythonCodeEphemeral(code) {
        const terminal = document.getElementById('terminal');
        
        // Add command to terminal (will auto-remove)
        this.addEphemeralMessage(`>>> ${code}`, 'command', LINE_LIFETIME_MS);
        
        console.log("📡 Sending code:", code);
        
        // Add to history
        this.commandHistory.push(code);
        this.historyIndex = this.commandHistory.length;
        
        try {
            const response = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code })
            });
            
            console.log("✅ Response status:", response.status);
            
            const result = await response.json();
            console.log("✅ Response data:", result);
            
            if (result.success) {
                console.log("✅ Command successful");
                
                // Show output if any (briefly)
                if (result.output) {
                    const lines = result.output.trim().split('\n');
                    lines.forEach(line => {
                        if (line.trim()) {
                            this.addEphemeralMessage(line, 'output', 2500);
                        }
                    });
                }
                
                // Show result if any (briefly)
                if (result.result && result.result !== 'None') {
                    this.addEphemeralMessage(`= ${result.result}`, 'output', 2500);
                }
                
                // Handle geometry updates
                if (result.geometry) {
                    console.log("🎨 Geometry data received:", result.geometry.length, "objects");
                    this.refreshSceneGeometry(result.geometry);
                    
                    // Show brief success message
                    if (result.geometry.length > 0) {
                        this.addEphemeralMessage(`✓ ${result.geometry.length} object(s) added`, 'success', 2000);
                    }
                } else {
                    console.log("❌ No geometry data in response");
                }
            } else {
                console.log("❌ Command failed:", result.message);
                // Errors stay longer
                this.addEphemeralMessage(`Error: ${result.message || result.error}`, 'error', 4000);
            }
        } catch (error) {
            console.error("❌ Network error:", error);
            this.addEphemeralMessage(`Network error: ${error.message}`, 'error', 4000);
        }
        
        // Clean up old messages
        this.cleanupTerminal();
    }

    async executePythonCode(code) {
        const terminal = document.getElementById('terminal');
        
        // Add command to terminal
        this.addToTerminal(`>>> ${code}`, 'command');

        console.log("📡 Sending code:", code);
        
        // Add to history
        this.commandHistory.push(code);
        this.historyIndex = this.commandHistory.length;
        
        try {
            const response = await fetch('/api/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code })
            });
            
            console.log("✅ Response status:", response.status);
            console.log("✅ Response headers:", response.headers);
            
            const result = await response.json();
            console.log("✅ Response data:", result);
            
            if (result.success) {
                console.log("✅ Command successful");
                // Show output if any
                if (result.output) {
                    this.addToTerminal(result.output, 'output');
                }
                
                // Show result if any (from eval)
                if (result.result && result.result !== 'None') {
                    this.addToTerminal(result.result, 'output');
                }
                
                // REPLACE ALL geometry in the scene with the current state
                if (result.geometry) {
                    console.log("🎨 Geometry data received:", result.geometry);
                    console.log("🔍 FIRST geometry object structure:", JSON.stringify(result.geometry[0], null, 2));
                    this.refreshSceneGeometry(result.geometry);
                    this.addToTerminal(`Scene updated with ${result.geometry.length} object(s)`, 'output');
                } else {
                console.log("❌ No geometry data in response");
                }
            } else {
                console.log("❌ Command failed:", result.message);
                this.addToTerminal(result.message || result.error, 'error');
            }
        } catch (error) {
            console.error("❌ Network error:", error); // DEBUG
            this.addToTerminal(`Network error: ${error.message}`, 'error');
        }
        
        // Scroll to bottom
        terminal.scrollTop = terminal.scrollHeight;
    }
    
    // Add ephemeral message that auto-removes
    addEphemeralMessage(text, className, duration = LINE_LIFETIME_MS) {
        const terminal = document.getElementById('terminal');
        const div = document.createElement('div');
        div.className = `terminal-${className}`;
        div.textContent = text;
        
        // Style based on class
        switch(className) {
            case 'command':
                div.style.color = '#64ffda';
                div.style.fontWeight = 'bold';
                break;
            case 'success':
                div.style.color = '#50fa7b';
                div.style.fontStyle = 'italic';
                div.style.marginLeft = '20px';
                break;
            case 'error':
                div.style.color = '#ff5555';
                div.style.marginLeft = '20px';
                break;
            case 'output':
                div.style.color = '#f8f8f2';
                div.style.marginLeft = '20px';
                div.style.fontFamily = "'Courier New', monospace";
                break;
        }
        
        // Add animation
        div.style.animation = 'fadeIn 0.3s ease';
        
        terminal.appendChild(div);
        
        // Auto-remove after duration
        setTimeout(() => {
            if (div.parentNode === terminal) {
                // Fade out
                div.style.opacity = '0';
                div.style.transition = 'opacity 0.5s ease';
                
                // Remove after fade
                setTimeout(() => {
                    if (div.parentNode === terminal) {
                        terminal.removeChild(div);
                        this.cleanupTerminal();
                    }
                }, 500);
            }
        }, duration);
        
        // Scroll to bottom
        terminal.scrollTop = terminal.scrollHeight;
    }



    addToTerminal(text, className) {
        const terminal = document.getElementById('terminal');
        const div = document.createElement('div');
        div.className = className;
        
        if (className === 'command') {
            // Make commands slightly bolder
            div.style.fontWeight = 'bold';
        }
        
        div.textContent = text;
        terminal.appendChild(div);
    }
    
    async loadCurrentGeometry() {
        console.log("🔄 loadCurrentGeometry called"); // debug

        try {
            const response = await fetch('/api/geometry');
            const data = await response.json();
            
            if (data.objects) {
                data.objects.forEach(geometry => {
                    this.addGeometryToScene(geometry);
                });
            }
            
            document.getElementById('status').textContent = `Loaded ${data.objects.length} objects`;
        } catch (error) {
            console.error('Failed to load geometry:', error);
            document.getElementById('status').textContent = 'Error loading geometry';
        }
    }

    // Clean up terminal to keep only limited lines
    cleanupTerminal() {
        const terminal = document.getElementById('terminal');
        const children = terminal.children;
        
        // If we have more than MAX_VISIBLE_LINES, remove the oldest
        if (children.length > MAX_VISIBLE_LINES) {
            const toRemove = children.length - MAX_VISIBLE_LINES;
            for (let i = 0; i < toRemove; i++) {
                if (terminal.firstChild) {
                    terminal.removeChild(terminal.firstChild);
                }
            }
        }
    }
    
    addGeometryToScene(geometryData) {
        const guid = geometryData.guid;
        console.log("🔍 Processing geometry:", geometryData.dtype, "GUID:", guid);
        
        // Skip if already added
        if (this.meshes.has(guid)) {
            console.log("⏭️ Already added, skipping");
            return;
        }

        
        let mesh = null;
        let color = new THREE.Color(Math.random(), Math.random(), Math.random());
        console.log("🎨 Creating mesh for:", geometryData.dtype);
        
        if (geometryData.dtype === 'compas.geometry/Box') {
            const boxData = geometryData.data;
            console.log("📦 Box data:", boxData);
            
            const boxGeometry = new THREE.BoxGeometry(boxData.xsize, boxData.ysize, boxData.zsize);
            const boxMaterial = new THREE.MeshPhongMaterial({ 
                color: color,
                transparent: true,
                opacity: 0.8 
            });
            mesh = new THREE.Mesh(boxGeometry, boxMaterial);
            
            const frame = boxData.frame;
            console.log("📍 Box position:", frame.point);
            mesh.position.set(frame.point[0], frame.point[1], frame.point[2]);
        }
        else if (geometryData.dtype === 'compas.geometry/Sphere') {
            const sphereData = geometryData.data;
            console.log("🔵 Sphere data:", sphereData);
            
            const sphereGeometry = new THREE.SphereGeometry(sphereData.radius, 32, 32);
            const sphereMaterial = new THREE.MeshPhongMaterial({ 
                color: color,
                transparent: true,
                opacity: 0.8 
            });
            mesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
            
            const frame = sphereData.frame;
            console.log("📍 Sphere position:", frame.point);
            mesh.position.set(frame.point[0], frame.point[1], frame.point[2]);
        }
        else if (geometryData.dtype === 'compas.geometry/Point') {
            const pointData = geometryData.data;
            console.log("⚫ Point data:", pointData);
            
            const pointGeometry = new THREE.SphereGeometry(0.1, 16, 16);
            const pointMaterial = new THREE.MeshPhongMaterial({ 
                color: color
            });
            mesh = new THREE.Mesh(pointGeometry, pointMaterial);
            
            console.log("📍 Point position:", pointData);
            mesh.position.set(pointData[0], pointData[1], pointData[2]);
        } else {
            console.log("❓ Unknown geometry type:", geometryData.dtype);
        }
        
        if (mesh) {
            console.log("✅ Adding mesh to scene");
            this.scene.add(mesh);
            this.meshes.set(guid, mesh);
        } else {
            console.log("❌ Failed to create mesh");
        }
    }
    
    onWindowResize() {
        const viewport = document.getElementById('viewport');
        this.camera.aspect = viewport.clientWidth / viewport.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(viewport.clientWidth, viewport.clientHeight);
    }
    
    animate() {
        requestAnimationFrame(() => this.animate());
        this.renderer.render(this.scene, this.camera);
    }

    clearTerminal() {
        document.getElementById('terminal').innerHTML = '';
        this.addToTerminal('Terminal cleared.', 'output');
    }
    
    async resetEnvironment() {
        try {
            const response = await fetch('/api/reset', { method: 'POST' });
            const result = await response.json();
            
            if (result.success) {
                location.reload();
            }
        } catch (error) {
            console.error('Reset failed:', error);
        }
    }

    refreshSceneGeometry(geometryData) {
        // Clear existing meshes (except helpers)
        this.meshes.forEach((mesh, guid) => {
            this.scene.remove(mesh);
        });
        this.meshes.clear();
        
        // Add all geometry from the server
        geometryData.forEach(geometry => {
            this.addGeometryToScene(geometry);
        });
    }

    createLayoutPlane() {
        // A4 size in meters (210mm x 297mm)
        const width = 0.210;  // 210mm in meters
        const height = 0.297; // 297mm in meters
        
        // Create plane for layout
        const geometry = new THREE.PlaneGeometry(width, height);
        
        // Semi-transparent white with border
        const material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.9,
            side: THREE.DoubleSide
        });
        
        this.layoutMesh = new THREE.Mesh(geometry, material);
        this.layoutMesh.position.set(0, 0, -0.001); // Slightly in front
        this.layoutMesh.rotation.x = Math.PI / 2; // Lay flat (horizontal)
        this.layoutMesh.visible = false; // Hidden by default
        
        // Add border
        const edges = new THREE.EdgesGeometry(geometry);
        const lineMaterial = new THREE.LineBasicMaterial({ 
            color: 0x000000, 
            linewidth: 2 
        });
        this.layoutBorder = new THREE.LineSegments(edges, lineMaterial);
        this.layoutBorder.position.copy(this.layoutMesh.position);
        this.layoutBorder.rotation.copy(this.layoutMesh.rotation);
        this.layoutBorder.visible = false;
        
        this.scene.add(this.layoutMesh);
        this.scene.add(this.layoutBorder);
    }
    
    setupViewModeToggle() {
        const btn3D = document.getElementById('3d-mode-btn');
        const btnLayout = document.getElementById('layout-mode-btn');
        
        btn3D.addEventListener('click', () => this.switchTo3DView());
        btnLayout.addEventListener('click', () => this.switchToLayoutView());
    }
    
    switchTo3DView() {
        this.isLayoutMode = false;
        
        // Update UI
        document.getElementById('3d-mode-btn').classList.add('active');
        document.getElementById('layout-mode-btn').classList.remove('active');
        
        // Hide layout
        if (this.layoutMesh) {
            this.layoutMesh.visible = false;
            this.layoutBorder.visible = false;
        }
        
        // Reset camera to 3D view
        this.camera.position.set(5, 5, 5);
        this.camera.lookAt(0, 0, 0);
        this.camera.zoom = 1;
        this.camera.updateProjectionMatrix();
        
        // Show 3D helpers
        this.scene.getObjectByName('gridHelper').visible = true;
        this.scene.getObjectByName('axesHelper').visible = true;
        
        // Update info text
        document.getElementById('info').innerHTML = `
            <div>COMPAS 3D Viewport</div>
            <div id="status">Ready</div>
            <div>Drag to rotate • Scroll to zoom</div>
        `;
    }
    
    switchToLayoutView() {
        this.isLayoutMode = true;
        
        // Update UI
        document.getElementById('3d-mode-btn').classList.remove('active');
        document.getElementById('layout-mode-btn').classList.add('active');
        
        // Show layout
        if (this.layoutMesh) {
            this.layoutMesh.visible = true;
            this.layoutBorder.visible = true;
        }
        
        // Switch to orthographic top-down view
        const viewport = document.getElementById('viewport');
        const aspect = viewport.clientWidth / viewport.clientHeight;
        
        // Create orthographic camera for 2D view
        const viewSize = 0.35; // meters visible
        this.camera = new THREE.OrthographicCamera(
            -viewSize * aspect,  // left
            viewSize * aspect,   // right
            viewSize,            // top
            -viewSize,           // bottom
            0.1,                 // near
            1000                 // far
        );
        
        // Position camera above layout
        this.camera.position.set(0, 0.5, 0);
        this.camera.lookAt(0, 0, 0);
        this.camera.zoom = 1;
        this.camera.updateProjectionMatrix();
        
        // Update renderer camera
        this.renderer.render(this.scene, this.camera);
        
        // Hide 3D helpers
        const gridHelper = this.scene.getObjectByName('gridHelper');
        const axesHelper = this.scene.getObjectByName('axesHelper');
        if (gridHelper) gridHelper.visible = false;
        if (axesHelper) axesHelper.visible = false;
        
        // Update info text
        document.getElementById('info').innerHTML = `
            <div>COMPAS Layout View</div>
            <div id="status">A4 Layout (210×297mm)</div>
            <div>Drag to pan • Scroll to zoom</div>
        `;
    }
    
    // Update controls for layout mode
    setupControls() {
        let isMouseDown = false;
        let previousMousePosition = { x: 0, y: 0 };
        
        this.renderer.domElement.addEventListener('mousedown', (e) => {
            isMouseDown = true;
            previousMousePosition = { x: e.offsetX, y: e.offsetY };
        });
        
        this.renderer.domElement.addEventListener('mouseup', () => {
            isMouseDown = false;
        });
        
        this.renderer.domElement.addEventListener('mousemove', (e) => {
            if (!isMouseDown) return;
            
            const deltaMove = {
                x: e.offsetX - previousMousePosition.x,
                y: e.offsetY - previousMousePosition.y
            };
            
            if (this.isLayoutMode) {
                // Pan in layout mode
                this.camera.position.x -= deltaMove.x * 0.002;
                this.camera.position.y += deltaMove.y * 0.002;
            } else {
                // Orbit in 3D mode
                this.camera.position.x -= deltaMove.x * 0.01;
                this.camera.position.y += deltaMove.y * 0.01;
                this.camera.lookAt(0, 0, 0);
            }
            
            previousMousePosition = { x: e.offsetX, y: e.offsetY };
        });
        
        this.renderer.domElement.addEventListener('wheel', (e) => {
            if (this.isLayoutMode) {
                // Zoom in/out in layout mode
                this.camera.zoom *= 1 + e.deltaY * -0.001;
                this.camera.zoom = Math.max(0.1, Math.min(10, this.camera.zoom));
                this.camera.updateProjectionMatrix();
            } else {
                // Zoom in 3D mode
                this.camera.position.multiplyScalar(1 + e.deltaY * 0.001);
            }
        });
    }
    
    // Update window resize handler
    onWindowResize() {
        const viewport = document.getElementById('viewport');
        
        if (this.isLayoutMode && this.camera.isOrthographicCamera) {
            // Update orthographic camera for layout mode
            const aspect = viewport.clientWidth / viewport.clientHeight;
            const viewSize = 0.35;
            
            this.camera.left = -viewSize * aspect;
            this.camera.right = viewSize * aspect;
            this.camera.top = viewSize;
            this.camera.bottom = -viewSize;
            this.camera.updateProjectionMatrix();
        } else {
            // Update perspective camera for 3D mode
            this.camera.aspect = viewport.clientWidth / viewport.clientHeight;
            this.camera.updateProjectionMatrix();
        }
        
        this.renderer.setSize(viewport.clientWidth, viewport.clientHeight);
    }
}

console.log("🔄 Class defined");

class FileExplorer {
    constructor() {
        this.currentPath = "";
        this.selectedFile = null;
        this.init();
    }
    
    async init() {
        await this.loadFileTree();
        this.setupEventListeners();
    }
    
    async loadFileTree(path = "") {
        try {
            const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
            const data = await response.json();
            this.renderFileTree(data);
        } catch (error) {
            console.error("Failed to load file tree:", error);
            document.getElementById('file-tree').innerHTML = `Error: ${error.message}`;
        }
    }
    
    renderFileTree(data) {
        const container = document.getElementById('file-tree');
    
        // Ensure arrays exist
        const directories = data.directories || [];
        const files = data.files || [];
        
        let html = `<div class="breadcrumb">${this.renderBreadcrumb(data.path || '')}</div>`;
        
        if (directories.length === 0 && files.length === 0) {
            html += `
                <div style="padding: 40px 20px; text-align: center; color: #888;">
                    <div style="font-size: 48px; margin-bottom: 20px;">📁</div>
                    <div style="margin-bottom: 20px;">No files yet</div>
                    <button onclick="createNewFile()" class="small-button" style="font-size: 14px; padding: 8px 16px;">
                        Create your first Python file
                    </button>
                </div>
            `;
        } else {
            // Directories first
            html += '<div style="margin-bottom: 10px;">';
            data.directories.forEach(dir => {
                html += `
                    <div class="directory" onclick="fileExplorer.openFolder('${this.escapeJs(dir.path)}')">
                        📁 ${this.escapeHtml(dir.name)}
                        <button class="delete-btn" onclick="event.stopPropagation(); fileExplorer.deleteItem('${this.escapeJs(dir.path)}')">×</button>
                    </div>
                `;
            });
            html += '</div>';
            
            // Files
            html += '<div>';
            data.files.forEach(file => {
                const isSelected = this.selectedFile === file.path;
                html += `
                    <div class="file ${isSelected ? 'selected' : ''}" 
                        onclick="fileExplorer.openFile('${this.escapeJs(file.path)}')">
                        📄 ${this.escapeHtml(file.name)}
                        <button class="delete-btn" onclick="event.stopPropagation(); fileExplorer.deleteItem('${this.escapeJs(file.path)}')">×</button>
                    </div>
                `;
            });
            html += '</div>';
        }
        
        container.innerHTML = html;
    }
    
    renderBreadcrumb(path) {
        if (!path) return '<span onclick="fileExplorer.openFolder(\'\')">🏠 /</span>';
        
        const parts = path.split('/');
        let breadcrumb = '<span onclick="fileExplorer.openFolder(\'\')">🏠</span>';
        let currentPath = "";
        
        parts.forEach(part => {
            if (part) {
                currentPath += (currentPath ? '/' : '') + part;
                breadcrumb += ` / <span onclick="fileExplorer.openFolder('${this.escapeJs(currentPath)}')">${this.escapeHtml(part)}</span>`;
            }
        });
        
        return breadcrumb;
    }
    
    async openFolder(path) {
        this.currentPath = path;
        await this.loadFileTree(path);
    }
    
    async openFile(filePath) {
        this.selectedFile = filePath;
        
        try {
            // Switch to terminal tab (where editor will open)
            switchTab('terminal');
            
            const response = await fetch(`/api/file/${encodeURIComponent(filePath)}`);
            const data = await response.json();
            
            // Replace terminal with editor
            this.openEditor(filePath, data.content);
            
            // Refresh file tree to show selected file
            await this.loadFileTree(this.currentPath);
        } catch (error) {
            console.error("Failed to open file:", error);
            alert(`Error opening file: ${error.message}`);
        }
    }
    
    openEditor(filePath, content) {
        const terminalContainer = document.getElementById('terminal-content');
        terminalContainer.innerHTML = `
            <div id="editor-header">
                <strong>📄 ${this.escapeHtml(filePath)}</strong>
                <div class="editor-controls">
                    <button class="small-button" onclick="fileExplorer.runCurrentFile()">▶ Run</button>
                    <button class="small-button" onclick="fileExplorer.saveCurrentFile()">💾 Save</button>
                    <button class="small-button" onclick="switchTab('explorer')">📁 Files</button>
                </div>
            </div>
            <textarea id="code-editor" placeholder="Edit your Python code here...">${this.escapeHtml(content)}</textarea>
            <div style="padding: 10px; background: #252525; border-top: 1px solid #333; font-size: 11px; color: #888;">
                <button class="small-button" onclick="fileExplorer.closeEditor()">Close</button>
                <span style="float: right;">Press Ctrl+S to save</span>
            </div>
        `;
        
        // Add keyboard shortcut
        const editor = document.getElementById('code-editor');
        editor.focus();
        editor.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.saveCurrentFile();
            }
        });
    }
    
    async saveCurrentFile() {
        if (!this.selectedFile) return;
        
        const editor = document.getElementById('code-editor');
        if (!editor) return;
        
        const content = editor.value;
        
        try {
            await fetch(`/api/file/${encodeURIComponent(this.selectedFile)}`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ content: content })
            });
            
            // Show temporary success message
            const header = document.getElementById('editor-header');
            const originalText = header.querySelector('strong').textContent;
            header.querySelector('strong').textContent = '✓ Saved! ' + originalText;
            setTimeout(() => {
                header.querySelector('strong').textContent = originalText;
            }, 2000);
        } catch (error) {
            console.error("Failed to save file:", error);
            alert(`Error saving file: ${error.message}`);
        }
    }
    
    async runCurrentFile() {
        if (!this.selectedFile) return;
        
        const editor = document.getElementById('code-editor');
        if (!editor) return;
        
        const code = editor.value;
        
        // Use existing viewport instance to execute code
        if (window.viewportInstance && viewportInstance.executePythonCode) {
            await viewportInstance.executePythonCode(code);
        } else {
            alert("Viewport not available");
        }
    }
    
    closeEditor() {
        // Restore original terminal view
        switchTab('terminal');
        
        // Reset terminal content (you might want to save this somewhere)
        const terminalContent = document.getElementById('terminal-content');
        terminalContent.innerHTML = `
            <div id="terminal-header">
                COMPAS Python Terminal
                <div style="font-size: 10px;">
                    <button class="small-button" onclick="viewportInstance.clearTerminal()">Clear</button>
                    <button class="small-button" onclick="viewportInstance.resetEnvironment()">Reset</button>
                </div>
            </div>
            <div id="terminal">
                <div class="output">COMPAS Web Viewport initialized. Type Python code below.</div>
            </div>
            <div id="code-input">
                <input type="text" id="terminal-input" placeholder="Type COMPAS Python code here..." style="width: 100%;">
            </div>
        `;
        
        // Re-attach terminal input listener
        this.setupTerminalInput();
    }
    
    setupTerminalInput() {
        const input = document.getElementById('terminal-input');
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && viewportInstance) {
                    const code = input.value.trim();
                    if (code) {
                        viewportInstance.executePythonCode(code);
                        input.value = '';
                    }
                }
            });
        }
    }
    
    escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
    
    escapeJs(text) {
        return text
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r");
    }
    
    setupEventListeners() {
        window.fileExplorer = this;
    }

    async createNewFile() {
        const name = prompt("Enter file name (with .py extension):", "new_script.py");
        if (name && name.endsWith('.py')) {
            const filePath = this.currentPath ? `${this.currentPath}/${name}` : name;
            
            try {
                await fetch(`/api/file/${encodeURIComponent(filePath)}`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ content: "# New COMPAS script\nfrom compas.geometry import Box\n\n# Write your code here\n" })
                });
                
                await this.loadFileTree(this.currentPath);
                await this.openFile(filePath);

            } catch (error) {
                console.error("Failed to create file:", error);
            }
        }
    }
    
    async createNewFolder() {
        const name = prompt("Enter folder name:", "new_folder");
        if (!name) return;
        
        // Remove slashes from folder name
        const folderName = name.replace(/[\/\\]/g, '_');
        
        try {
            const response = await fetch(`/api/folder/${encodeURIComponent(this.currentPath)}`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ name: folderName })
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || "Failed to create folder");
            }
            
            // Refresh file list
            await this.loadFileTree(this.currentPath);
            
        } catch (error) {
            console.error("Failed to create folder:", error);
            alert(`Error: ${error.message}`);
        }
    }

}



// Initialize after DOM loads
let fileExplorer;

window.addEventListener('DOMContentLoaded', () => {
    viewportInstance = new CompasWebViewport();
    fileExplorer = new FileExplorer();
});



let viewportInstance;

console.log("🔄 Variable declared");

window.addEventListener('DOMContentLoaded', () => {
    console.log("🔄 DOMContentLoaded fired");
    viewportInstance = new CompasWebViewport();
    console.log("🔄 Instance created:", viewportInstance);
});

console.log("🔄 Event listener attached");



const ephemeralCSS = `
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(-5px); }
    to { opacity: 1; transform: translateY(0); }
}

.terminal-command {
    animation: fadeIn 0.2s ease;
}

.terminal-success {
    animation: fadeIn 0.3s ease;
}

.terminal-error {
    animation: fadeIn 0.3s ease;
}

.terminal-output {
    animation: fadeIn 0.3s ease;
}
`;

// Add CSS to document
document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = ephemeralCSS;
    document.head.appendChild(style);
});
