from flask import Flask, request, jsonify, send_from_directory, send_file
from flask_cors import CORS
import subprocess
import tempfile
import os


app = Flask(__name__)
CORS(app)

@app.route('/')
def start_index():
    return send_from_directory('.', 'index.html')

@app.route('/app.js')
def serve_js():
    return send_file('app.js')

@app.route('/execute', methods=['POST'])
def execute_code():
    # 1. Take Python code from request
    # 2. Save to temporary file
    # 3. Run it with python command
    # 4. Return output

    # Get the code from frontend
    data = request.json
    code = data.get('code', 'print("No code provided")')

    # Create a temporary file to save the code
    with tempfile.NamedTemporaryFile(delete=False, suffix='.py') as temp_file:
        temp_file.write(code.encode('utf-8'))
        temp_file_path = temp_file.name

    try:
        # Execute the code using subprocess
        result = subprocess.run(['monacovenv/bin/python', temp_file_path], capture_output=True, text=True, timeout=5)

        # Prepare the response
        output = result.stdout
        error = result.stderr

        response = {
            'success': result.returncode == 0,
            'output': output,
            'error': error
        }
        return jsonify(response)

    except subprocess.TimeoutExpired:
        response = {
            'output': '',
            'error': 'Execution timed out.'
        }
    finally:
        # Clean up the temporary file
        if os.path.exists(temp_file_path):
            os.unlink(temp_file_path)

@app.route('/test', methods=['GET'])
def test():
    """Simple test endpoint to check if server is running"""
    return jsonify({'status': 'Server is running!'})


if __name__ == '__main__':
    # Run on localhost, port 8000
    app.run(host='0.0.0.0', port=8000, debug=True)