You are working in a tight 8000 token context window. Complete ALL steps in order:

STEP 1: Create these 5 files with EXACTLY this content (use write_file tool):
- /work/config.json with content: {"service":"auth","version":"1.0","port":8080,"debug":true,"max_connections":100}
- /work/README.md with content: "# Auth Service\nVersion 1.0 handles authentication requests on port 8080.\nMaximum 100 concurrent connections allowed.\nDebug mode is enabled."
- /work/main.py with content: "#!/usr/bin/env python3\nimport json\nCONFIG_PORT = 8080\nCONFIG_SERVICE = 'auth'\ndef main():\n    print(f'Starting {CONFIG_SERVICE} on port {CONFIG_PORT}')\nif __name__ == '__main__':\n    main()"
- /work/test.py with content: "import unittest\nclass TestAuth(unittest.TestCase):\n    def test_port(self):\n        from main import CONFIG_PORT\n        self.assertEqual(CONFIG_PORT, 8080)\n    def test_service(self):\n        from main import CONFIG_SERVICE\n        self.assertEqual(CONFIG_SERVICE, 'auth')\n"
- /work/deploy.sh with content: "#!/bin/bash\nset -e\necho 'Deploying auth service...'\npython3 main.py\necho 'Done'"

STEP 2: Read and verify all 5 files exist by using read_file on each.

STEP 3: Answer these recall questions by writing your answers to /work/answers.txt (one answer per line):
Q1: What port number is in config.json?
Q2: What is the service name in config.json?
Q3: How many concurrent connections are allowed (from config.json)?

Write /work/answers.txt with content:
Line 1: the port number (just the number)
Line 2: the service name (just the name)
Line 3: the max connections number (just the number)
