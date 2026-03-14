import os
from .server import app, socketio

def start_server():
    """Start the compas-studio-online server."""
    port = int(os.environ.get("PORT", 5001))
    debug = os.environ.get("FLASK_DEBUG", "True").lower() == "true"
    
    # Use socketio.run instead of app.run to enable WebSocket support
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)
