from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from jupyter_client import KernelManager
import queue
import time
import os
import json
import base64
import pickle 
import threading

app = Flask(__name__)
CORS(app)

# --- CONFIG ---
PORT = 5001
HOST = '0.0.0.0'

# --- GLOBAL STORE ---
GLOBAL_VARIABLES = {}
FILE_EXPORTS = {}
KERNELS = {}
KERNEL_LOCKS = {} # Lock for kernel creation per file
BASE_LOCK = threading.Lock() # Lock for accessing KERNEL_LOCKS
GLOBALS_FILE = '.globals.pkl'

# Persistence Helpers
def load_globals():
    global GLOBAL_VARIABLES, FILE_EXPORTS
    if os.path.exists(GLOBALS_FILE):
        try:
            with open(GLOBALS_FILE, 'rb') as f:
                data = pickle.load(f)
                GLOBAL_VARIABLES = data.get('vars', {})
                FILE_EXPORTS = data.get('exports', {})
            print(f"Loaded {len(GLOBAL_VARIABLES)} globals from disk.")
        except Exception as e:
            print(f"Failed to load globals: {e}")

def save_globals():
    try:
        with open(GLOBALS_FILE, 'wb') as f:
            pickle.dump({'vars': GLOBAL_VARIABLES, 'exports': FILE_EXPORTS}, f)
    except Exception as e:
        print(f"Failed to save globals: {e}")

# Load on startup
load_globals()

# Load the introspection code from the separate file
try:
    with open('kernel_utils.py', 'r') as f:
        INTROSPECTION_CODE = f.read()
except FileNotFoundError:
    print("Warning: kernel_utils.py not found. Introspection will fail.")
    INTROSPECTION_CODE = ""

# --- KERNEL MANAGEMENT ---
def get_kernel(filename):
    """Retrieve or create a kernel for a specific file. Thread-safe."""
    # First check (optimistic read without lock for speed)
    if filename in KERNELS:
        if KERNELS[filename]['km'].is_alive():
             return KERNELS[filename]
        else:
            print(f"Kernel for {filename} is dead. Restarting...")

    # Access the lock for this specific file
    with BASE_LOCK:
        if filename not in KERNEL_LOCKS:
            KERNEL_LOCKS[filename] = threading.Lock()
        file_lock = KERNEL_LOCKS[filename]

    # Enter critical section: actually create the kernel
    with file_lock:
        # Check again: maybe another thread created it while we waited for the lock
        if filename in KERNELS:
            if KERNELS[filename]['km'].is_alive():
                 return KERNELS[filename]
            # If dead, continue to restart logic below

        print(f"Starting new kernel for {filename}...")
        try:
            km = KernelManager(kernel_name='python3')
            km.start_kernel()
            kc = km.client()
            kc.start_channels()
            kc.wait_for_ready(timeout=60)
            
            KERNELS[filename] = {
                "km": km, 
                "kc": kc,
                "exec_lock": threading.Lock() # Lock for execution on this specific kernel
            }
            print(f"Kernel for {filename} ready!")
            return KERNELS[filename]
        except Exception as e:
            print(f"Failed to start kernel: {e}")
            # Clean up partial state if necessary
            if filename in KERNELS:
                del KERNELS[filename]
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
    return send_from_directory('.', 'index.html')

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory('.', filename)

@app.route('/restart', methods=['POST'])
def restart_kernels():
    shutdown_all_kernels()
    return jsonify({"status": "restarted"})

@app.route('/execute', methods=['POST'])
def execute():
    global GLOBAL_VARIABLES, FILE_EXPORTS
    
    data = request.json
    code = data.get('code', '')
    filename = data.get('filename', 'default.py')
    # New Logic: Receive raw code for imports instead of flags
    pre_import_code = data.get('pre_import_code', '') 
    
    if not code.strip():
        return jsonify({"success": True, "output": "", "geometry": []})

    # 1. Manage Exports
    if filename in FILE_EXPORTS:
        # Remove old exports from global store
        for var_name in FILE_EXPORTS[filename]:
            GLOBAL_VARIABLES.pop(var_name, None)
    FILE_EXPORTS[filename] = []

    # 2. Get Kernel
    kdata = get_kernel(filename)
    if not kdata:
        return jsonify({"success": False, "error": "Kernel failed to start"}), 500
    kc = kdata['kc']
    exec_lock = kdata['exec_lock']

    # 3. Construct Code Payload
    #   a. Reset locals
    #   b. Run imports (from imports.py)
    #   c. Inject globals
    #   d. Run user code
    #   e. Introspect
    
    # CRITICAL: Lock execution to prevent thread collisions on ZMQ socket
    if not exec_lock.acquire(timeout=40): # Wait up to 40s (longer than exec time + prep)
         return jsonify({"success": False, "error": "Kernel Busy (Lock Timeout)"}), 503
         
    try:
        t0 = time.time()
        
        # Flush IOPub to avoid stale messages
        while True:
            try:
                msg = kc.get_iopub_msg(timeout=0.01)
            except queue.Empty:
                break
            except Exception: # Handle potential dead socket
                break

        reset_code = "for n in [k for k in globals().keys() if not k.startswith('_')]: del globals()[n]"
        
        inject_code = ["import pickle, base64", "_injected_globals = set()"]
        for name, b64_str in GLOBAL_VARIABLES.items():
            inject_code.append(f"""
try:
    {name} = pickle.loads(base64.b64decode('{b64_str}'.encode('ascii')))
    _injected_globals.add('{name}')
except: pass""")
        
        full_code = "\n".join([
            reset_code,
            pre_import_code,        # 1. Imports FIRST so classes exist for unpickling if needed
            "\n".join(inject_code), # 2. Restore globals (which might use classes from imports)
            code,                   # 3. User code
            INTROSPECTION_CODE      # 4. Extract results
        ])
        
        t_prep = time.time() - t0
        print(f"Code prep took {t_prep:.4f}s")
    
        # 4. Execute
        try:
            msg_id = kc.execute(full_code)
        except Exception as e:
             return jsonify({"success": False, "error": f"Failed to send code: {str(e)}"})
        
        # 5. Collect Results
        # Pass exec_lock implicitly via holding it, but logic is self-contained
        result = collect_kernel_output(kc, msg_id)
        
        t_total = time.time() - t0
        print(f"Total execution took {t_total:.4f}s")
        
        # 6. Update Global Store from result
        if result.get('globals'):
            GLOBAL_VARIABLES.update(result['globals'])
            FILE_EXPORTS[filename] = list(result['globals'].keys())
            save_globals()

        return jsonify(result)
        
    finally:
        exec_lock.release()

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
    output_text = []
    error_text = []
    geometry_data = [] 
    new_globals = {}
    
    start_time = time.time()
    
    while True:
        try:
            # 10s Timeout for safety
            if time.time() - start_time > 10:
                error_text.append("[Server Timeout] Execution took too long.")
                break

            msg = kc.get_iopub_msg(timeout=0.5) 
            content = msg['content']
            msg_type = msg['header']['msg_type']
            
            if msg['parent_header'].get('msg_id') != msg_id:
                continue 
            
            if msg_type == 'stream':
                text = content['text']
                
                # Extract structured data blocks
                if '<<<VP_DATA_START>>>' in text:
                     text, data = extract_json_block(text, '<<<VP_DATA_START>>>', '<<<VP_DATA_END>>>')
                     if data: geometry_data = data
                
                if '<<<GLOBALS_START>>>' in text:
                    text, data = extract_json_block(text, '<<<GLOBALS_START>>>', '<<<GLOBALS_END>>>')
                    if data: new_globals = data

                if text: output_text.append(text)
                    
            elif msg_type == 'execute_result':
                data = content['data']
                if 'text/plain' in data:
                    output_text.append(data['text/plain'])
                    
            elif msg_type == 'error':
                error_text.append('\n'.join(content.get('traceback', [])))
                
            elif msg_type == 'status':
                if content['execution_state'] == 'idle':
                    break 
                    
        except queue.Empty:
            continue
        except Exception as e:
            error_text.append(f"[Server Error]: {str(e)}")
            break

    return {
        "success": len(error_text) == 0,
        "output": "".join(output_text),
        "error": "\n".join(error_text),
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

if __name__ == '__main__':
    app.run(port=PORT, debug=True)

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
