print("ok")
# box = Box(1,1,1)

col = 10 # range(1,10)
row = 6 # range(1,10)
boxes = []

zaxis = Vector(0,0,1)

for i in range(col):
    for j in range(row):
        if (i+j) % 2:
            point = Point(i, 0, j)
            frame = Frame(point)
            box = Box(2,1,1, frame)
            rotbox = box.rotated(math.sin(i + j), zaxis, point)
            boxes.append(rotbox)
        elif i == 0:
            point = Point(-0.5, 0, j)
            frame = Frame(point)
            box = Box(1,1,1, frame)
            rotbox = box.rotated(math.sin(i + j), zaxis, point)
            boxes.append(rotbox)
        elif i == (col - 1):
            point = Point((col-0.5), 0, j)
            frame = Frame(point)
            box = Box(1,1,1, frame)
            rotbox = box.rotated(math.sin(i + j), zaxis, point)
            boxes.append(rotbox)
        
        
        

    