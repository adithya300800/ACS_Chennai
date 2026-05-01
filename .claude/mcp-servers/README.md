# SSH MCP Server

A Model Context Protocol server that enables Claude Code to execute commands on remote servers via SSH.

## Setup

1. **Install sshpass** (required for password authentication):
   ```bash
   # macOS
   brew install sshpass

   # Ubuntu/Debian
   sudo apt install sshpass
   ```

2. **Configure your server credentials** in `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "ssh": {
         "command": "node",
         "args": [
           "/path/to/ssh-server.js",
           "--host", "192.168.1.100",
           "--port", "22",
           "--user", "your-username",
           "--password", "your-password"
         ]
       }
     }
   }
   ```

3. **Restart Claude Code** to load the MCP server.

## Available Tools

| Tool | Description |
|------|-------------|
| `ssh_execute` | Execute a shell command on the remote server |
| `ssh_upload` | Upload a local file to the remote server via SCP |
| `ssh_download` | Download a file from the remote server |
| `ssh_test` | Test the SSH connection and get server info |

## Usage

Once configured, you can ask Claude Code to:
- "Check the disk space on our server"
- "Restart the nginx service"
- "Upload this config file to the server"
- "Download the logs from /var/log/"

## Security Notes

- This server uses password authentication via `sshpass`. For better security, consider setting up SSH key-based authentication.
- Credentials are stored in plain text in `.mcp.json` — keep this file private and add it to `.gitignore`.
- To use SSH keys instead of passwords, omit `--password` and use `--key-file`:
  ```
  node ssh-server.js --host IP --user USER --key-file /path/to/id_rsa
  ```
