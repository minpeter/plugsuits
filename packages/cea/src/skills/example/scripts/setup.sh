#!/bin/bash
# Setup script for example skill

echo "Setting up example skill..."
echo "This is a demonstration of v2 skill subdirectory files"

# Check environment
if [ -z "$USER" ]; then
    echo "Error: USER environment variable not set"
    exit 1
fi

echo "Setup complete for user: $USER"
