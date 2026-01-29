#!/bin/bash
cd /Users/dominicweber/Library/CloudStorage/GoogleDrive-dominictsweber@gmail.com/My Drive/ETH/Semester 2/Focus Work/compas-web-viewport
source venv/bin/activate
cd backend
python server.py
sleep 2
open http://localhost:8000
