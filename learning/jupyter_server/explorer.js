console.log('File Explorer loaded');

let currentFile = null;

/**
 * Fetch and display list of .py files from workspace
 */
async function listFiles() {
    try {
        const res = await fetch('/files');
        const files = await res.json();
        const list = document.getElementById('file-list');
        list.innerHTML = '';
        files.forEach(name => {
            const li = document.createElement('li');
            li.textContent = name;
            li.style.cursor = 'pointer';
            li.addEventListener('click', () => openFile(name));
            list.appendChild(li);
        });
    } catch (err) {
        console.error('Failed to list files', err);
    }
}

/**
 * Open a file and load it into the editor
 */
async function openFile(name) {
    try {
        const res = await fetch('/files/' + encodeURIComponent(name));
        if (!res.ok) throw new Error('Failed to open file');
        const text = await res.text();
        editor.setValue(text);
        currentFile = name;
        document.getElementById('current-file').textContent = name;
    } catch (err) {
        console.error(err);
        alert('Could not open file: ' + err.message);
    }
}

/**
 * Save current editor content to file
 */
async function saveFile() {
    if (!currentFile) {
        const name = prompt('Filename (with .py):', 'untitled.py');
        if (!name) return;
        currentFile = name;
        document.getElementById('current-file').textContent = name;
    }
    try {
        await fetch('/files/' + encodeURIComponent(currentFile), {
            method: 'PUT',
            headers: {'Content-Type': 'text/plain'},
            body: editor.getValue()
        });
        alert('Saved: ' + currentFile);
        listFiles();
    } catch (err) {
        console.error('Save failed', err);
        alert('Save failed: ' + err.message);
    }
}

/**
 * Create a new file
 */
async function newFile() {
    const name = prompt('New filename (with .py):', 'untitled.py');
    if (!name) return;
    try {
        const res = await fetch('/files', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name})
        });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error || 'Could not create file');
        await openFile(r.name);
        listFiles();
    } catch (err) {
        console.error('New file failed', err);
        alert('New file failed: ' + err.message);
    }
}

// Wire up UI buttons
window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('clear-files').addEventListener('click', clearFiles);
    async function clearFiles() {
        try {
            const res = await fetch('/files', { method: 'DELETE' });
            const result = await res.json();
            listFiles();
            if (result.deleted && result.deleted.length > 0) {
                alert('All files deleted.');
            } else if (result.errors && result.errors.length > 0) {
                alert('Some files could not be deleted:\n' + result.errors.join('\n'));
            } else {
                alert('No files were deleted.');
            }
        } catch (err) {
            console.error('Clear failed', err);
            alert('Clear failed: ' + err.message);
        }
    }
    document.getElementById('new-file').addEventListener('click', newFile);
    document.getElementById('save-file').addEventListener('click', saveFile);
    document.getElementById('run-file').addEventListener('click', runCode);

    // Load file list on startup
    listFiles();
});