# Simple decorator that prints before and after function calls
def my_decorator(func):
    def wrapper():
        print("↳ BEFORE: About to run the function")
        result = func()  # Call the original function
        print("↳ AFTER: Function finished running")
        return result
    return wrapper

# Using the decorator
@my_decorator
def say_hello():
    print("    Hello World!")
    return "Done"

# Without decorator (manual version)
def say_goodbye():
    print("    Goodbye World!")
    return "Finished"

# Manually apply decorator
say_goodbye = my_decorator(say_goodbye)

# Test them
print("=== Testing say_hello (with @ decorator) ===")
result1 = say_hello()
print(f"Returned: {result1}")

print("\n=== Testing say_goodbye (manual decorator) ===")
result2 = say_goodbye()
print(f"Returned: {result2}")