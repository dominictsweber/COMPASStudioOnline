from .server import app

def start_server():
    """Start the compas-web-viewport server."""
    app.run(port=5001, debug=True)
