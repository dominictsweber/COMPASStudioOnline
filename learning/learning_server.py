from http.server import HTTPServer, SimpleHTTPRequestHandler
import socketserver

PORT = 8000

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.path = 'frontend/learning_index.html'
        return SimpleHTTPRequestHandler.do_GET(self)
    
with socketserver.TCPServer(("", PORT), Handler) as httpd:
    httpd.serve_forever()

    print(f"Serving at port {PORT}")