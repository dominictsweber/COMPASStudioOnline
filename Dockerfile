# Use an official Python runtime as a parent image
FROM python:3.11-slim-bookworm

# Copy the uv binary from the official image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

# Set the working directory to /app
WORKDIR /app

# Copy dependency files
COPY pyproject.toml uv.lock ./

# Install dependencies into the system python environment
RUN uv sync --frozen --no-dev --no-install-project

# Copy the current directory contents into the container at /app
COPY . .

# Install the project itself (if it's a package) or sync final state
RUN uv sync --frozen --no-dev

# Add the virtual environment to the PATH
ENV PATH="/app/.venv/bin:$PATH"

# Make port 5001 available to the world outside this container
EXPOSE 5001

# Run server.py when the container launches
CMD ["python", "server.py"]
