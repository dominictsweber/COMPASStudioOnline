# Create boxes
from compas.geometry import Box

# Simple box
box1 = Box.from_width_height_depth(2, 1, 0.5)
box1.frame.point = [0, 0, 0]

# Another box
box2 = Box.from_width_height_depth(1, 1, 1)
box2.frame.point = [3, 0, 0]

scene_objects.extend([box1, box2])
print("Created 2 boxes!")
