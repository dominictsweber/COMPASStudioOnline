"""
COMPAS Studio Online - Jupyter Kernel Version
Simple Flask server with persistent Jupyter kernel for stateful code execution.
"""

from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_cors import CORS
from jupyter_client import KernelManager
import os

app = Flask(__name__)
CORS(app)

# Workspace for project files
WORKSPACE = os.path.join(os.path.dirname(__file__), 'workspace')
os.makedirs(WORKSPACE, exist_ok=True)

# ============================================================================
# JUPYTER KERNEL SETUP (The core of the Jupyter approach)
# ============================================================================

print("Starting Jupyter kernel...")
kernel_manager = KernelManager()
kernel_manager.start_kernel()
kernel_client = kernel_manager.client()

# Explicitly load connection file to ensure correct key/signature setup
kernel_client.load_connection_file(kernel_manager.connection_file)
kernel_client.start_channels()
try:
    kernel_client.wait_for_ready(timeout=10)
    print("Jupyter kernel started successfully!")
except RuntimeError:
    print("Warning: Kernel didn't become ready in 10s")

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _safe_path(name):
    """Prevent path traversal attacks - ensure file is in workspace."""
    safe_name = os.path.basename(name)
    if not safe_name.endswith('.py'):
        safe_name = f"{safe_name}.py"
    return os.path.join(WORKSPACE, safe_name)

def execute_in_kernel(code):
    """
    Execute code in the persistent Jupyter kernel and collect output.
    
    Returns a dict with:
    - success: bool (True if code ran without error)
    - output: str (stdout)
    - error: str (stderr or execution error)
    """
    try:
        # Send code to kernel
        msg_id = kernel_client.execute(code)
        
        output = ""
        error = ""
        
        # Collect output messages from kernel
        # The kernel sends messages on the iopub channel
        while True:
            try:
                # Wait for a message (timeout=0.5s)
                msg = kernel_client.get_iopub_msg(timeout=0.5)
                msg_type = msg['header']['msg_type']
                content = msg['content']
                
                # Collect different message types
                if msg_type == 'stream':
                    # stdout or stderr from print()
                    if content['name'] == 'stdout':
                        output += content['text']
                    elif content['name'] == 'stderr':
                        error += content['text']
                
                elif msg_type == 'execute_result':
                    # Return value of expression
                    if 'text/plain' in content['data']:
                        output += content['data']['text/plain']
                
                elif msg_type == 'error':
                    # Execution error (exception)
                    traceback_lines = content.get('traceback', [])
                    error += '\n'.join(traceback_lines)
                
                elif msg_type == 'status':
                    # status == 'idle' means kernel finished
                    if content['execution_state'] == 'idle':
                        break
            
            except Exception:
                raise
            #     # Timeout - try once more for status
            #     try:
            #         msg = kernel_client.get_iopub_msg(timeout=0.1)
            #         if msg['header']['msg_type'] == 'status':
            #             if msg['content']['execution_state'] == 'idle':
            #                 break
            #     except:
            #         break
        
        return {
            'success': not error,
            'output': output,
            'error': error
        }
    
    except Exception as e:
        import traceback
        return {
            'success': False,
            'output': '',
            'error': f"Kernel error: {str(e)}\n\nTraceback:\n{traceback.format_exc()}"
        }

# ============================================================================
# REST ENDPOINTS
# ============================================================================

@app.route('/')
def start_index():
    """Serve the main HTML file."""
    return send_from_directory('.', 'index.html')

@app.route('/app.js')
def serve_app_js():
    """Serve the Monaco editor script."""
    return send_file('app.js')

@app.route('/explorer.js')
def serve_explorer_js():
    """Serve the file explorer script."""
    return send_file('explorer.js')

# @app.route('/viewport.js')
# def serve_viewport_js():
#     return send_file('viewport.js')

# @app.route('/livetoggle.js')
# def serve_livetoggle_js():
#     """Serve the livetoggle script."""
#     return send_file('livetoggle.js')

# @app.route('/explorer.css')
# def serve_explorer_css():
#     """Serve the explorer styles."""
#     return send_file('explorer.css')

# ============================================================================
# FILE MANAGEMENT ENDPOINTS
@app.route('/files', methods=['DELETE'])
def delete_all_files():
    """Delete all .py files in the workspace."""
    deleted = []
    errors = []
    for fname in os.listdir(WORKSPACE):
        if fname.endswith('.py'):
            try:
                os.remove(os.path.join(WORKSPACE, fname))
                deleted.append(fname)
            except Exception as e:
                errors.append(f"{fname}: {str(e)}")
    return jsonify({'success': True, 'deleted': deleted, 'errors': errors})
# ============================================================================

@app.route('/files', methods=['GET'])
def list_files():
    """List all .py files in the workspace."""
    files = [f for f in os.listdir(WORKSPACE) if f.endswith('.py')]
    return jsonify(files)

@app.route('/files', methods=['POST'])
def create_file():
    """Create a new empty .py file."""
    data = request.json or {}
    name = data.get('name') or 'untitled.py'
    path = _safe_path(name)
    if os.path.exists(path):
        return jsonify({'success': False, 'error': 'File already exists'}), 400
    open(path, 'w').close()
    return jsonify({'success': True, 'name': os.path.basename(path)})

@app.route('/files/<name>', methods=['GET'])
def get_file(name):
    """Read a file from the workspace."""
    path = _safe_path(name)
    if not os.path.exists(path):
        return jsonify({'success': False, 'error': 'Not found'}), 404
    return send_file(path)

@app.route('/files/<name>', methods=['PUT'])
def save_file(name):
    """Save/update a file in the workspace."""
    path = _safe_path(name)
    content = request.get_data(as_text=True)
    with open(path, 'w') as fh:
        fh.write(content)
    return jsonify({'success': True})

@app.route('/files/<name>', methods=['DELETE'])
def delete_file(name):
    """Delete a file from the workspace."""
    path = _safe_path(name)
    if os.path.exists(path):
        os.remove(path)
        return jsonify({'success': True})
    return jsonify({'success': False, 'error': 'Not found'}), 404

# ============================================================================
# CODE EXECUTION ENDPOINT
# ============================================================================

@app.route('/execute', methods=['POST'])
def execute_code():
    """
    Execute code in the persistent Jupyter kernel.
    The kernel keeps state between runs (variables, imports, etc).
    """
    data = request.json or {}
    code = data.get('code', 'print("No code provided")')
    
    # Execute in the kernel (state persists!)
    result = execute_in_kernel(code)
    
    return jsonify(result)

@app.route('/kernel-status', methods=['GET'])
def kernel_status():
    """Check if the kernel is alive."""
    try:
        kernel_client.kernel_info()
        return jsonify({'status': 'alive'})
    except:
        return jsonify({'status': 'dead'}), 503

# ============================================================================
# MAIN
# ============================================================================

if __name__ == '__main__':
    try:
        print("Starting COMPAS Studio Online (Jupyter Kernel version)")
        print("Open http://localhost:8000 in your browser")
        app.run(host='0.0.0.0', port=8000, debug=False)
    finally:
        # Cleanup: stop the kernel when server shuts down
        print("Stopping Jupyter kernel...")
        kernel_manager.shutdown_kernel()
