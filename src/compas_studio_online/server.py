from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO, join_room, leave_room, emit
from jupyter_client import KernelManager
import queue
import time
import os
import json
import base64
import pickle 
import threading
import shutil
import random

app = Flask(__name__)
CORS(app)
# Force threading mode to avoid ZMQ blocking eventlet loop
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# --- CONFIG ---
PORT = int(os.environ.get('PORT', 5001))
HOST = '0.0.0.0'
STATIC_FOLDER = os.path.dirname(os.path.abspath(__file__))
PROJECTS_DIR = os.path.join(STATIC_FOLDER, 'projects')

# --- GLOBAL STORE ---
# Keyed by Project ID
GLOBAL_VARIABLES = {} # { project_id: { var: b64, ... } }
FILE_EXPORTS = {}     # { project_id: { file: [vars], ... } }
KERNELS = {}          # { "project_id/filename": { km, kc, lock } }
KERNEL_LOCKS = {}     # { "project_id/filename": Lock }
BASE_LOCK = threading.Lock() 

# --- HIBERNATION MANAGEMENT ---
PROJECT_ACTIVITY = {} # { project_id: timestamp }
HIBERNATION_TIMEOUT = 1800 # 30 minutes (seconds)
HIBERNATION_CHECK_INTERVAL = 60 # Check every minute

def update_activity(project_id):
    if project_id and project_id != 'default':
        PROJECT_ACTIVITY[project_id] = time.time()

def get_project_state_file(project_id):
    return os.path.join(PROJECTS_DIR, project_id, '.state.pkl')

def save_project_state(project_id):
    """Save global variables to disk for a specific project."""
    if project_id not in GLOBAL_VARIABLES: return
    
    path = get_project_state_file(project_id)
    try:
        data = {
            'vars': GLOBAL_VARIABLES.get(project_id, {}),
            'exports': FILE_EXPORTS.get(project_id, {})
        }
        with open(path, 'wb') as f:
            pickle.dump(data, f)
        # print(f"[Hibernation] State saved for {project_id}")
    except Exception as e:
        print(f"[Hibernation] Failed to save state for {project_id}: {e}")

def load_project_state(project_id):
    """Load global variables from disk for a specific project."""
    path = get_project_state_file(project_id)
    if os.path.exists(path):
        try:
            with open(path, 'rb') as f:
                data = pickle.load(f)
                GLOBAL_VARIABLES[project_id] = data.get('vars', {})
                FILE_EXPORTS[project_id] = data.get('exports', {})
            print(f"[Hibernation] State loaded for {project_id}")
            return True
        except Exception as e:
            print(f"[Hibernation] Failed to load state for {project_id}: {e}")
    return False

def hibernate_project(project_id):
    """Shut down kernels and clear memory for an idle project."""
    print(f"[Hibernation] Hibernating project {project_id}...")
    
    # 1. Save State
    save_project_state(project_id)
    
    # 2. Shutdown Kernels
    # Create list of keys to remove (avoid dict size change during iteration)
    to_remove = []
    prefix = f"{project_id}/"
    
    with BASE_LOCK:
        for key, kdata in KERNELS.items():
            if key.startswith(prefix):
                try:
                    kdata['km'].shutdown_kernel()
                except Exception as e:
                     print(f"Error shutting down kernel {key}: {e}")
                to_remove.append(key)
        
        for key in to_remove:
            del KERNELS[key]
            # Also remove locks? Optional, but cleaner.
            if key in KERNEL_LOCKS:
                del KERNEL_LOCKS[key]
                
    # 3. Clear Memory
    if project_id in GLOBAL_VARIABLES: del GLOBAL_VARIABLES[project_id]
    if project_id in FILE_EXPORTS: del FILE_EXPORTS[project_id]
    if project_id in PROJECT_ACTIVITY: del PROJECT_ACTIVITY[project_id]
    
    print(f"[Hibernation] Project {project_id} is now dormant.")

def ensure_project_active(project_id):
    """Wake up project if dormant."""
    update_activity(project_id)
    
    # If already in memory, good to go
    if project_id in GLOBAL_VARIABLES:
        return

    print(f"[Hibernation] Waking up project {project_id}...")
    
    # 1. Load State
    # Initialize empty first
    GLOBAL_VARIABLES[project_id] = {}
    FILE_EXPORTS[project_id] = {}
    
    has_state = load_project_state(project_id)
    
    # 2. Re-Execute All Files
    # We walk the directory and execute every .py file
    # This restores local variables/functions and regenerates geometry
    project_path = os.path.join(PROJECTS_DIR, project_id)
    if not os.path.exists(project_path): return

    # Helper to find execution logic (we re-use a simplified version of execute_code logic because we can't call route handler easily)
    # Actually, we can just instantiate kernels and run code.
    
    # Find imports.py first?
    files_to_run = []
    imports_file = None
    
    for root, _, files in os.walk(project_path):
        for fname in files:
            if fname.endswith('.py'):
                full_path = os.path.join(root, fname)
                rel_path = os.path.relpath(full_path, project_path)
                
                # Exclude internal files
                if fname == 'read_me.py' and 'imports.py' in files: 
                     # Should we run read_me.py? Probably yes if it has code.
                     pass
                
                with open(full_path, 'r') as f:
                    code = f.read()
                
                if fname == 'imports.py':
                    imports_file = (rel_path, code)
                else:
                    files_to_run.append((rel_path, code))
    
    # Prepend imports.py
    if imports_file:
        files_to_run.insert(0, imports_file)
    
    # Run them
    for fname, code in files_to_run:
        print(f"[Hibernation] Re-running {fname}...")
        # We need to construct the payload for execute_internal
        # But we don't have execute_internal extracted yet.
        # Let's extract core execution logic from the route to a function.
        internal_execute(project_id, fname, code, "")

def internal_execute(project_id, filename, code, pre_import_code):
    """Core execution logic shared by route and wake-up."""
    try:
        kdata = get_kernel(project_id, filename)
    except Exception as e:
        print(f"Error getting kernel: {e}")
        return None
        
    if not kdata: return None
    
    kc = kdata['kc']
    exec_lock = kdata['exec_lock']
    
    # Ensure project stores exist
    if project_id not in GLOBAL_VARIABLES: GLOBAL_VARIABLES[project_id] = {}
    if project_id not in FILE_EXPORTS: FILE_EXPORTS[project_id] = {}
    current_project_globals = GLOBAL_VARIABLES[project_id]

    if not exec_lock.acquire(timeout=40): 
        print(f"Failed to acquire lock for {filename}")
        return None
         
    try:
        # Check if socket is alive?
        try:
            kc.get_iopub_msg(timeout=0.01) # Flush check
        except: pass 

        # 1. Manage Exports - Clear old globals from this file
        if filename in FILE_EXPORTS[project_id]:
            for var_name in FILE_EXPORTS[project_id][filename]:
                current_project_globals.pop(var_name, None)
        FILE_EXPORTS[project_id][filename] = [] # Reset for this run

        # Construct Code
        reset_code = "for n in [k for k in globals().keys() if not k.startswith('_')]: del globals()[n]"
        inject_code = ["import pickle, base64", "_injected_globals = set()"]
        for name, b64_str in current_project_globals.items():
            inject_code.append(f"try:\n    {name} = pickle.loads(base64.b64decode('{b64_str}'.encode('ascii')))\n    _injected_globals.add('{name}')\nexcept: pass")
    
        full_code = "\n".join([
            reset_code,
            pre_import_code,        
            "\n".join(inject_code), 
            code,                   
            INTROSPECTION_CODE      
        ])
        
        try:
            msg_id = kc.execute(full_code)
            result = collect_kernel_output(kc, msg_id)
            
            # Update Globals and Exports
            if result.get('globals'):
                current_project_globals.update(result['globals'])
                FILE_EXPORTS[project_id][filename] = list(result['globals'].keys())
                
            return result
        except Exception as e:
            print(f"Error executing {filename}: {e}")
            return None
    finally:
        exec_lock.release()

def hibernation_monitor():
    """Background thread to check for idle projects."""
    while True:
        time.sleep(HIBERNATION_CHECK_INTERVAL)
        now = time.time()
        
        # Identify idle projects
        # Note: We must be careful iterating while modifying
        active_projects = list(PROJECT_ACTIVITY.items())
        
        for pid, last_active in active_projects:
            if now - last_active > HIBERNATION_TIMEOUT:
                hibernate_project(pid)

# Start Monitor
threading.Thread(target=hibernation_monitor, daemon=True).start()

# Load the introspection code from the separate file
try:
    with open(os.path.join(os.path.dirname(__file__), 'kernel_utils.py'), 'r') as f:
        INTROSPECTION_CODE = f.read()
except FileNotFoundError:
    print("Warning: kernel_utils.py not found. Introspection will fail.")
    INTROSPECTION_CODE = ""

# --- KERNEL MANAGEMENT ---
def get_kernel(project_id, filename):
    """Retrieve or create a kernel for a specific file in a project."""
    unique_key = f"{project_id}/{filename}"
    
    # First check (optimistic)
    if unique_key in KERNELS:
        if KERNELS[unique_key]['km'].is_alive():
             return KERNELS[unique_key]
        else:
            print(f"Kernel for {unique_key} is dead. Restarting...")

    # Access the lock for this specific file
    with BASE_LOCK:
        if unique_key not in KERNEL_LOCKS:
            KERNEL_LOCKS[unique_key] = threading.Lock()
        file_lock = KERNEL_LOCKS[unique_key]

    # Enter critical section
    with file_lock:
        if unique_key in KERNELS:
            if KERNELS[unique_key]['km'].is_alive():
                 return KERNELS[unique_key]

        print(f"Starting new kernel for {unique_key}...")
        try:
            km = KernelManager(kernel_name='python3')
            km.start_kernel()
            kc = km.client()
            kc.start_channels()
            kc.wait_for_ready(timeout=60)
            
            KERNELS[unique_key] = {
                "km": km, 
                "kc": kc,
                "exec_lock": threading.Lock() 
            }
            print(f"Kernel for {unique_key} ready!")
            return KERNELS[unique_key]
        except Exception as e:
            print(f"Failed to start kernel ({unique_key}): {e}")
            if unique_key in KERNELS: del KERNELS[unique_key]
            return None

def shutdown_all_kernels():
    global KERNELS, GLOBAL_VARIABLES, FILE_EXPORTS, KERNEL_LOCKS
    
    # We should probably lock creation of new kernels while shutting down
    with BASE_LOCK:
        # First shut them down
        current_kernels = list(KERNELS.items()) # Snapshot to avoid iteration errors
        for fname, kdata in current_kernels:
            try:
                kdata['km'].shutdown_kernel()
            except Exception as e:
                print(f"Error shutting down kernel {fname}: {e}")
        
        # Then clear
        KERNELS = {}
        GLOBAL_VARIABLES = {} 
        FILE_EXPORTS = {}
        # KERNEL_LOCKS = {} # We can clear locks too, or keep them. Safer to keep locks or re-init?
        # If threads are waiting on locks, they will wake up and see KERNELS is empty, so they will start new kernels.
        # This is acceptable for a restart.

# --- ROUTING ---
@app.route('/')
def index():
    return send_from_directory(STATIC_FOLDER, 'index.html')

@app.route('/<path:filename>')
def serve_static(filename):
    # Check if this is a project key (5 digits)
    if filename.isdigit() and len(filename) == 5:
         if os.path.exists(os.path.join(PROJECTS_DIR, filename)):
             return send_from_directory(STATIC_FOLDER, 'editor.html')
    return send_from_directory(STATIC_FOLDER, filename)

@app.route('/projects', methods=['GET'])
def list_projects():
    if not os.path.exists(PROJECTS_DIR):
        os.makedirs(PROJECTS_DIR)
    
    projects = []
    for entry in os.scandir(PROJECTS_DIR):
        if entry.is_dir() and not entry.name.startswith('.'):
            # Try to load metadata
            meta_path = os.path.join(entry.path, 'project.json')
            name = entry.name
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, 'r') as f:
                        meta = json.load(f)
                        name = meta.get('name', entry.name)
                except:
                    pass
            
            projects.append({
                "key": entry.name,
                "name": name,
                "created": entry.stat().st_ctime
            })
    projects.sort(key=lambda x: x['created'], reverse=True)
    return jsonify(projects)

@app.route('/projects/create', methods=['POST'])
def create_project():
    data = request.json
    name = data.get('name')
    if not name:
        return jsonify({"success": False, "error": "Name required"}), 400
    
    # Generate unique 5-digit key
    attempts = 0
    while attempts < 100:
        key = str(random.randint(10000, 99999))
        path = os.path.join(PROJECTS_DIR, key)
        if not os.path.exists(path):
            break
        attempts += 1
    else:
        return jsonify({"success": False, "error": "Failed to generate unique key"}), 500
        
    try:
        os.makedirs(path)
        # Create metadata
        with open(os.path.join(path, 'project.json'), 'w') as f:
            json.dump({"name": name, "created": time.time()}, f)

        # Create default files
        with open(os.path.join(path, 'imports.py'), 'w') as f:
            f.write('# Anything imported here is accessible in the entire project.\n\nfrom compas.geometry import Box, Frame, Point, Vector\nimport math\n')
        
        with open(os.path.join(path, 'read_me.py'), 'w') as f:
            f.write('# Activating Live coding will run your code as soon as you stop typing.\n\n'
                    '# Using the syntax //# range (x, y)// will create a slider. For example:\n'
                    'a = 0 # range(0, 10)\n\n'
                    '# Using the syntax //# switch (var1, var2, var3)// will create a switch. For example:\n'
                    'current_variable = 0 # switch(0, 1, 2)\n\n'
                    '# Use the prefix glb_ in front of variable names to use them in other files.\n\n'
                    '# Click on geometry in the viewport to add their corresponding variable name to the current editor.')
            
        return jsonify({"success": True, "key": key, "name": name})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/projects/delete', methods=['POST'])
def delete_project():
    data = request.json
    key = data.get('key')
    if not key:
        return jsonify({"success": False, "error": "Key required"}), 400
    
    path = os.path.join(PROJECTS_DIR, key)
    if not os.path.exists(path):
        return jsonify({"success": False, "error": "Project not found"}), 404
        
    try:
        shutil.rmtree(path)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/projects/rename', methods=['POST'])
def rename_project():
    data = request.json
    key = data.get('key')
    name = data.get('name')
    if not key or not name:
        return jsonify({"success": False, "error": "Key and name required"}), 400
    
    path = os.path.join(PROJECTS_DIR, key)
    if not os.path.exists(path):
        return jsonify({"success": False, "error": "Project not found"}), 404

    try:
        meta_path = os.path.join(path, 'project.json')
        meta = {}
        if os.path.exists(meta_path):
             with open(meta_path, 'r') as f:
                  meta = json.load(f)
        
        meta['name'] = name
        with open(meta_path, 'w') as f:
            json.dump(meta, f)
            
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/<project_key>')
def open_project(project_key):
    # Check if this is a project key (5 digits)
    if project_key.isdigit() and len(project_key) == 5:
         path = os.path.join(PROJECTS_DIR, project_key)
         if os.path.exists(path):
             return send_from_directory(STATIC_FOLDER, 'editor.html')
    
    # Otherwise treat as static file fallback or 404
    # But wait, serve_static below handles generic filenames. 
    # If project_key matches a filename in root, serve_static handles it if we don't catch it here.
    # Flask routes match in order.
    # Let's let serve_static handle filenames, but how do we distinguish '98383' from 'app.js'?
    # 'app.js' is not 5 digits.
    return serve_static(project_key)

@app.route('/project/<project_name>/files', methods=['GET'])
def list_project_files(project_name):
    path = os.path.join(PROJECTS_DIR, project_name)
    if not os.path.exists(path):
        return jsonify({"success": False, "error": "Project not found"}), 404
    
    files = []
    # Simple flat list for now, or recursive? 
    # Let's support shallow for now or simple recursion.
    # Actually, the frontend expects a tree structure or flat list it can parse?
    # The frontend currently has a hardcoded structure. Let's return a flat list of files with content.
    
    # Get project name from metadata
    project_display_name = project_name
    try:
        with open(os.path.join(path, 'project.json'), 'r') as f:
            meta = json.load(f)
            project_display_name = meta.get('name', project_name)
    except:
        pass
    
    # Walk and collect both folders and files
    for root, dirs, files_in_dir in os.walk(path):
        # Filter hidden dirs
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']
        
        # Add directories as empty files with type 'folder' (hack to preserve structure if empty)
        # But actually, the frontend might reconstruct hierarchy from file paths.
        # If folder is empty, we must include it expressly.
        for d in dirs:
            full_path = os.path.join(root, d)
            rel_path = os.path.relpath(full_path, path)
            files.append({
                "name": rel_path,
                "type": "folder",
                "content": ""
            })

        for fname in files_in_dir:
            if fname.startswith('.') or fname.endswith('.pyc') or fname == '__pycache__' or fname == 'project.json' or fname == '.workspace.json':
                continue
            
            full_path = os.path.join(root, fname)
            rel_path = os.path.relpath(full_path, path)
            
            try:
                with open(full_path, 'r') as f:
                    content = f.read()
            except Exception as e:
                print(f"Error reading file {full_path}: {e}")
                content = "" # Fallback
                
            files.append({
                "name": rel_path,
                "type": "file",
                "content": content
            })
            
    return jsonify({"success": True, "files": files, "projectName": project_display_name, "projectKey": project_name})

@app.route('/project/<project_name>/save', methods=['POST'])
def save_project_file(project_name):
    data = request.json
    filename = data.get('filename') # Relative path
    content = data.get('content')
    
    if not filename or content is None:
        return jsonify({"success": False, "error": "Filename and content required"}), 400
        
    project_path = os.path.join(PROJECTS_DIR, project_name)
    if not os.path.exists(project_path):
        return jsonify({"success": False, "error": "Project not found"}), 404
        
    # Prevent path traversal
    safe_path = os.path.normpath(os.path.join(project_path, filename))
    if not safe_path.startswith(os.path.abspath(project_path)):
         return jsonify({"success": False, "error": "Invalid path"}), 403
         
    try:
        # Create dirs if needed
        os.makedirs(os.path.dirname(safe_path), exist_ok=True)
        with open(safe_path, 'w') as f:
            f.write(content)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/project/<project_name>/create_folder', methods=['POST'])
def create_project_folder(project_name):
    data = request.json
    path = data.get('path') # Relative path
    
    if not path:
        return jsonify({"success": False, "error": "Path required"}), 400
        
    project_path = os.path.join(PROJECTS_DIR, project_name)
    if not os.path.exists(project_path):
        return jsonify({"success": False, "error": "Project not found"}), 404
        
    safe_path = os.path.normpath(os.path.join(project_path, path))
    if not safe_path.startswith(os.path.abspath(project_path)):
         return jsonify({"success": False, "error": "Invalid path"}), 403
         
    try:
        os.makedirs(safe_path, exist_ok=True)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/project/<project_name>/delete_node', methods=['POST'])
def delete_project_node(project_name):
    data = request.json
    path = data.get('path') # Relative path
    
    if not path:
        return jsonify({"success": False, "error": "Path required"}), 400
        
    project_path = os.path.join(PROJECTS_DIR, project_name)
    safe_path = os.path.normpath(os.path.join(project_path, path))
    if not safe_path.startswith(os.path.abspath(project_path)):
         return jsonify({"success": False, "error": "Invalid path"}), 403
    
    if not os.path.exists(safe_path):
        return jsonify({"success": False, "error": "Path not found"}), 404
        
    try:
        if os.path.isdir(safe_path):
            shutil.rmtree(safe_path)
        else:
            os.remove(safe_path)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/project/<project_name>/rename_node', methods=['POST'])
def rename_project_node(project_name):
    data = request.json
    old_path = data.get('oldPath')
    new_path = data.get('newPath')
    
    if not old_path or not new_path:
        return jsonify({"success": False, "error": "Paths required"}), 400
        
    project_path = os.path.abspath(os.path.join(PROJECTS_DIR, project_name))
    safe_old = os.path.normpath(os.path.join(project_path, old_path))
    safe_new = os.path.normpath(os.path.join(project_path, new_path))
    
    if not safe_old.startswith(project_path) or not safe_new.startswith(project_path):
         return jsonify({"success": False, "error": "Invalid path"}), 403
         
    if not os.path.exists(safe_old):
        return jsonify({"success": False, "error": "Source not found"}), 404
    
    if os.path.exists(safe_new):
        return jsonify({"success": False, "error": "Destination already exists"}), 400
        
    try:
        os.rename(safe_old, safe_new)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/restart', methods=['POST'])
def restart_kernels():
    shutdown_all_kernels()
    return jsonify({"status": "restarted"})

@app.route('/execute', methods=['POST'])
def execute_code_route():
    data = request.json
    filename = data.get('filename')
    code = data.get('code')
    pre_import_code = data.get('pre_import_code', '')
    project_id = data.get('project', 'default')

    if not filename or code is None:
        return jsonify({"success": False, "error": "Missing filename or code"}), 400
    
    # Check if project was asleep or loading
    ensure_project_active(project_id)
    
    result = internal_execute(project_id, filename, code, pre_import_code)
    
    if result:
        return jsonify(result)
    else:
        return jsonify({"success": False, "error": "Internal execution failed"}), 500

@app.route('/project/<project_name>/workspace', methods=['GET', 'POST'])
def workspace_state(project_name):
    update_activity(project_name) # Keep alive
    # Determine local file path
    # If project_name differs from dir key, find by key or name?
    # Usually project_name here is likely the key from URL (5 digits).
    
    path = os.path.join(PROJECTS_DIR, project_name)
    if not os.path.exists(path):
        return jsonify({"success": False, "error": "Project not found"}), 404
        
    workspace_file = os.path.join(path, '.workspace.json')
    
    if request.method == 'GET':
        if os.path.exists(workspace_file):
            try:
                with open(workspace_file, 'r') as f:
                    return jsonify(json.load(f))
            except:
                return jsonify({})
        else:
            return jsonify({})
            
    elif request.method == 'POST':
        data = request.json
        try:
            with open(workspace_file, 'w') as f:
                json.dump(data, f)
            return jsonify({"success": True})
        except Exception as e:
            return jsonify({"success": False, "error": str(e)}), 500



def collect_kernel_output(kc, msg_id):
    # Buffer lists
    output_text_parts = []
    error_text_parts = []
    geometry_data = [] 
    new_globals = {}
    
    # Stream accumulator for potential split JSON messages
    stream_buffer = []
    
    start_time = time.time()
    next_log_time = start_time + 1.0
    
    while True:
        try:
            # 30s Timeout for safety, increased to allow imports/startups
            if time.time() - start_time > 30:
                print(f"[DEBUG] MsgID {msg_id} TIMEOUT")
                error_text_parts.append("[Server Timeout] Execution took too long.")
                break
                
            if time.time() > next_log_time:
                # print(f"[DEBUG] Waiting for output... {time.time()-start_time:.1f}s")
                next_log_time += 1.0

            msg = kc.get_iopub_msg(timeout=0.1)  # Faster polling
            content = msg['content']
            msg_type = msg['header']['msg_type']
            parent_id = msg['parent_header'].get('msg_id')
            
            # Filter unrelated messages
            if parent_id != msg_id:
                continue 
            
            if msg_type == 'stream':
                text = content['text']
                stream_buffer.append(text)
                # Don't process immediately, wait for idle to process full buffer?
                # Or process incrementally?
                # Best is to append to buffer.
                    
            elif msg_type == 'execute_result':
                data = content['data']
                if 'text/plain' in data:
                    output_text_parts.append(data['text/plain'])
                    
            elif msg_type == 'error':
                error_msg = '\n'.join(content.get('traceback', []))
                print(f"[DEBUG] Error received: {error_msg}")
                error_text_parts.append(error_msg)
                
            elif msg_type == 'status':
                if content['execution_state'] == 'idle':
                    print(f"[DEBUG] Execution Finished (idle)")
                    break 
                    
        except queue.Empty:
            continue
        except Exception as e:
            print(f"[DEBUG] Exception in loop: {e}")
            error_text_parts.append(f"[Server Error]: {str(e)}")
            break

    # Process buffered stream output at the end
    full_stream_text = "".join(stream_buffer)
    
    # 1. Extract Geometry Data
    if '<<<VP_DATA_START>>>' in full_stream_text:
        full_stream_text, data = extract_json_block(full_stream_text, '<<<VP_DATA_START>>>', '<<<VP_DATA_END>>>')
        if data: geometry_data = data
    
    # 2. Extract Globals Data
    if '<<<GLOBALS_START>>>' in full_stream_text:
        full_stream_text, data = extract_json_block(full_stream_text, '<<<GLOBALS_START>>>', '<<<GLOBALS_END>>>')
        if data: new_globals = data

    # 3. Remaining text is user output
    if full_stream_text:
        output_text_parts.append(full_stream_text)

    return {
        "success": len(error_text_parts) == 0,
        "output": "".join(output_text_parts),
        "error": "\n".join(error_text_parts),
        "geometry": geometry_data,
        "globals": new_globals
    }

def extract_json_block(text, start_tag, end_tag):
    """Refined extraction of JSON blocks from text stream."""
    extracted_data = None
    clean_text = text
    
    # Simple algorithm: Find start, find end after start
    s = text.find(start_tag)
    if s != -1:
        e = text.find(end_tag, s) # Look for end AFTER start
        
        if e != -1:
            json_str = text[s + len(start_tag) : e].strip()
            try:
                extracted_data = json.loads(json_str)
            except json.JSONDecodeError:
                pass # Malformed JSON
                
            # Remove the whole block including tags and optional trailing newline
            block_end = e + len(end_tag)
            
            # Check for trailing newline
            if block_end < len(text) and text[block_end] == '\n':
                block_end += 1
            elif block_end + 1 < len(text) and text[block_end:block_end+2] == '\r\n':
                block_end += 2
                
            clean_text = text[:s] + text[block_end:]
        
    return clean_text, extracted_data

# --- AI ENDPOINTS ---

@app.route('/api/ai_edit', methods=['POST'])
def ai_edit():
    """
    Mock AI Editor Endpoint.
    Replace the logic here with a call to OpenAI, Anthropic, or local LLM.
    """
    data = request.json
    prompt = data.get('prompt', '')
    context = data.get('context', '')
    selection = data.get('selection', '')
    
    # ---------------------------------------------------------
    # Example using OpenAI (pseudo-code):
    # response = openai.ChatCompletion.create(
    #     model="gpt-4",
    #     messages=[
    #         {"role": "system", "content": "You are a Python coding assistant. Return only the code block."},
    #         {"role": "user", "content": f"Context:\n{context}\n\nSelection:\n{selection}\n\nTask: {prompt}"}
    #     ]
    # )
    # return jsonify({"code": response.choices[0].message.content})
    # ---------------------------------------------------------
    
    # mock response for now
    time.sleep(1) # Simulate network latency
    
    if "box" in prompt.lower():
        mock_code = "box = Box(Frame.worldXY(), 5, 5, 5)\n"
    elif "sphere" in prompt.lower():
        mock_code = "sphere = Sphere(Point(0,0,0), 3.0)\n"
    elif "test" in prompt.lower():
        mock_code = "# This is a test response from the AI assistant.\nprint('Hello from AI!')\n"
    else:
        mock_code = f"# AI Generated Code for: {prompt}\n# Please configure API Key in server.py\n"

    return jsonify({"code": mock_code})

# --- SOCKET EVENTS ---
@socketio.on('join')
def on_join(data):
    project = data.get('project')
    if project:
        join_room(project)
        update_activity(project)
        # Ensure project is awake when user joins
        # We do this asynchronously or fast?
        # Ideally synchronous so they see state, but it might block the socket handshake.
        # Let's trust the client will call loadWorkspace/loadFiles soon which triggers activity too.
        # But to be safe:
        ensure_project_active(project)
        print(f"User joined project room: {project}")

@socketio.on('leave')
def on_leave(data):
    project = data.get('project')
    if project:
        leave_room(project)
        print(f"User left project room: {project}")

@socketio.on('code_change')
def on_code_change(data):
    """
    Broadcast code changes to other users in the same project room.
    """
    project = data.get('project')
    if project:
        update_activity(project)
        # Broadcast to everyone in the room EXCEPT sender (include_self=False)
        emit('code_update', data, room=project, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host=HOST, port=PORT, debug=True)
