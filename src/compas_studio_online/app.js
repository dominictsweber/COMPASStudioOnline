
// Project Overview Logic

document.addEventListener('DOMContentLoaded', () => {
    // Check if URL has a project key
    const path = window.location.pathname.substring(1);
    if (path && /^\d+$/.test(path)) {
        openEditor(path);
    } else {
        loadProjects();
    }
    
    setupModal();
    setupToast();
});

// --- View Switching ---
function showProjectList() {
    document.getElementById('project-list-view').style.display = 'block';
    document.getElementById('editor-view').style.display = 'none';
    window.history.pushState(null, '', '/');
    loadProjects(); // Refresh list
}

function showEditorView(projectKey) {
    document.getElementById('project-list-view').style.display = 'none';
    document.getElementById('editor-view').style.display = 'flex';
    window.history.pushState(null, '', `/${projectKey}`);
}

// Ensure global access for external scripts (editor.js)
window.showProjectList = showProjectList;
window.showEditorView = showEditorView;
window.openEditor = openEditor;

// --- Bridge to Editor ---
async function openEditor(projectKey) {
    showEditorView(projectKey);
    
    // Wait for Monaco and core dependencies to load via RequireJS in editor.js
    if (App.monacoPromise) {
        await App.monacoPromise;
    } else {
        // Just in case it hasn't started yet (race condition on load)
        // We can retry or assume editor.js will set it soon.
        // A simple loop:
        let attempts = 0;
        while (!App.monacoPromise && attempts < 20) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }
        if (App.monacoPromise) await App.monacoPromise;
    }

    // Initialize App structure if needed
    if (!App.initialized) {
        App.init(); 
    }

    // Check if we are already on this project (avoid reload if unnecessary)
    if (App.state && App.state.currentProjectName === projectKey) {
        console.log("Returning to active project:", projectKey);
        if (App.viewport && App.viewport.onWindowResize) App.viewport.onWindowResize();
        return;
    }
    
    // Load the project
    await App.loadProject(projectKey);
}

// --- State ---
let isCreating = false;

// --- Projects ---
async function loadProjects() {
    const container = document.getElementById('project-list');
    
    try {
        const response = await fetch('/projects');
        if (!response.ok) throw new Error('Failed to fetch');
        
        const projects = await response.json();
        container.innerHTML = '';
        
        // 1. Render Existing Projects
        projects.forEach(p => {
            const card = document.createElement('div'); // Changed to div for click handler
            card.className = 'project-card';
            // card.href = `/${p.key}`; // No link, use click
            card.onclick = () => openEditor(p.key);
            
            const date = new Date(p.created * 1000).toLocaleDateString(undefined, {
                year: 'numeric', month: 'short', day: 'numeric'
            });
            
            // Prevent navigating when clicking actions
            const deleteHandler = `event.preventDefault(); event.stopPropagation(); deleteProject('${p.key}')`;
            const copyHandler = `event.preventDefault(); event.stopPropagation(); copyKey('${p.key}')`;
            // Escape single quotes for JS string
            const safeName = p.name ? p.name.replace(/'/g, "\\'") : '';
            const renameHandler = `event.preventDefault(); event.stopPropagation(); renameProject('${p.key}', '${safeName}')`;
            
            card.innerHTML = `
                <div class="card-header">
                    <div class="project-icon"><i class="fas fa-cube"></i></div>
                    <div class="card-actions">
                        <button class="action-btn btn-rename" onclick="${renameHandler}" title="Rename Project">
                            <i class="fas fa-pen"></i>
                        </button>
                        <button class="action-btn btn-copy" onclick="${copyHandler}" title="Copy Key">
                            <i class="fas fa-key"></i>
                        </button>
                        <button class="action-btn btn-delete" onclick="${deleteHandler}" title="Delete Project">
                            <i class="fas fa-minus"></i>
                        </button>
                    </div>
                </div>
                <div class="project-title">${p.name}</div>
                <div class="project-key">#${p.key}</div>
                <div class="project-meta"><i class="far fa-clock"></i> ${date}</div>
            `;
            container.appendChild(card);
        });

        // 2. Render "New Project" Card
        const newCard = document.createElement('div');
        newCard.className = 'new-project-card';
        newCard.onclick = openModal;
        newCard.innerHTML = `
            <div class="new-project-icon"><i class="fas fa-plus"></i></div>
            <div class="new-project-text">New Project</div>
        `;
        container.appendChild(newCard); // Add at the end
        
    } catch (e) {
        console.error("Failed to load projects", e);
        container.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; color: #d32f2f;">
                <p>Failed to load projects. Is the server running?</p>
            </div>
        `;
    }
}

// --- Actions ---

window.deleteProject = async (key) => {
    if (!confirm('Are you sure you want to delete this project?')) return;
    
    try {
        const res = await fetch('/projects/delete', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({key})
        });
        if (res.ok) {
            showToast('Project deleted');
            loadProjects();
        } else {
            alert('Failed to delete');
        }
    } catch (e) {
        console.error(e);
        alert('Error deleting project');
    }
};

window.renameProject = async (key, currentName) => {
    const newName = prompt('Enter new project name:', currentName);
    if (!newName || newName === currentName) return;

    try {
        const res = await fetch('/projects/rename', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({key, name: newName})
        });
        if (res.ok) {
            showToast('Project renamed');
            loadProjects();
        } else {
            alert('Failed to rename');
        }
    } catch (e) {
        console.error(e);
        alert('Error renaming project');
    }
};

window.copyKey = (key) => {
    navigator.clipboard.writeText(key).then(() => {
        showToast(`Key copied: ${key}`);
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
};

// --- Modal ---
// Delay access to DOM elements until function call to ensure safety if elements missing
let modal, input, createBtn, cancelBtn;

function setupModal() {
    modal = document.getElementById('new-project-modal');
    input = document.getElementById('project-name-input');
    createBtn = document.getElementById('btn-create');
    cancelBtn = document.getElementById('btn-cancel');

    if (!modal || !input || !createBtn || !cancelBtn) {
        // Elements not present (likely in editor view), skip setup
        return;
    }
    
    cancelBtn.onclick = closeModal;
    createBtn.onclick = createProject;
    
    // Close on click outside
    modal.onclick = (e) => {
        if (e.target === modal) closeModal();
    };
    
    // Enter key
    input.onkeydown = (e) => {
        input.style.borderColor = '';
        if (e.key === 'Enter') createProject();
        if (e.key === 'Escape') closeModal();
    };
}

window.openModal = () => {
    if (!modal) return;
    modal.style.display = 'block'; // Ensure visible first
    // Use class if CSS controls opacity/transition
    modal.classList.add('visible');
    if (input) {
        input.value = '';
        setTimeout(() => input.focus(), 100);
    }
};

window.closeModal = () => {
    if (modal) {
        modal.classList.remove('visible');
        setTimeout(() => { 
            if(!modal.classList.contains('visible')) modal.style.display = 'none'; 
        }, 300); // Wait for transition
    }
};

async function createProject() {
    if (!input) return;
    const name = input.value.trim();
    if (!name) {
        input.style.borderColor = '#d32f2f';
        return;
    }
    
    if (isCreating) return;
    isCreating = true;
    createBtn.innerText = 'Creating...';
    
    try {
        const response = await fetch('/projects/create', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name})
        });
        
        const result = await response.json();
        
        if (result.success) {
            closeModal();
            showToast('Project created successfully');
            loadProjects();
        } else {
            alert('Error: ' + result.error);
        }
    } catch (e) {
        console.error(e);
        alert('Failed to create project');
    } finally {
        isCreating = false;
        createBtn.innerText = 'Create';
    }
}

// --- Toast ---
let toastTimeout;
function setupToast() {
    // nothing to setup really
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-msg');
    
    msgEl.innerText = msg;
    toast.classList.add('visible');
    
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        toast.classList.remove('visible');
    }, 3000);
}
