# Migrating to Jupyter Kernel - Setup Instructions

## What Changed

This project now uses a **persistent Jupyter kernel** instead of spawning a fresh Python subprocess for each run. This means:

✅ **State persists** - Define a variable in one run, use it in the next  
✅ **Faster execution** - No spawn overhead (kernel stays alive)  
✅ **Foundation for rich outputs** - Ready for images, widgets, etc later



## How It Works

### Backend: `server.py` (the key part)

```python
# On startup, create a persistent kernel
kernel_manager = KernelManager()
kernel_manager.start_kernel()
kernel_client = kernel_manager.client()
```

When you run code via `/execute`:

```python
@app.route('/execute', methods=['POST'])
def execute_code():
    code = request.json['code']
    msg_id = kernel_client.execute(code)  # Send to kernel
    # Collect output messages from kernel
    # Return them as JSON
```

The key difference: instead of `subprocess.run()`, we send code to a **persistent kernel** and collect its output messages.

### Frontend: Simple and unchanged

- `app.js` - Monaco editor, calls `/execute` 
- `explorer.js` - File management
- `index.html` - Clean layout (no viewport)

**Demo: State Persists**

1. Create a file `demo.py` with:
```python
x = 10
print(f"x = {x}")
```

2. Run it → Output: `x = 10`

3. Change code to:
```python
x = x + 5
print(f"x = {x}")
```

4. Run again → Output: `x = 15` (NOT 11!)

The kernel **remembered** `x = 10` from the first run. That's the magic of persistent kernels.

## Understanding the Code

### `server.py` - Key function: `execute_in_kernel()`

```python
def execute_in_kernel(code):
    """Execute code and collect output from kernel."""
    
    # 1. Send code to kernel
    msg_id = kernel_client.execute(code)
    
    # 2. Collect output messages (stdout, errors, etc)
    while True:
        msg = kernel_client.get_iopub_msg(timeout=0.5)
        msg_type = msg['header']['msg_type']
        
        if msg_type == 'stream':
            output += content['text']  # Capture print() output
        elif msg_type == 'error':
            error += traceback  # Capture exceptions
        elif msg_type == 'status' and state == 'idle':
            break  # Kernel finished
    
    return {'success': not error, 'output': output, 'error': error}
```

The kernel sends messages on a **channel** (iopub = input/output public channel). We listen and collect all messages until the kernel reports it's idle.

### What you can try next

1. **Multi-cell execution** - The kernel stays alive between runs
2. **Geometry export** - Modify `/execute` to detect and export geometry
3. **Add a viewport** - Re-add Three.js rendering using geometry from kernel output

---

Good luck! If something doesn't work, check:
- Is the kernel starting? (check console output)
- Is `/kernel-status` endpoint alive? (`curl http://localhost:8000/kernel-status`)
- Are ports and paths correct?