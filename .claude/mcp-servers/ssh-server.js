#!/usr/bin/env node
/**
 * SSH MCP Server for Claude Code
 *
 * Allows Claude Code to execute commands on remote servers via SSH.
 *
 * Usage:
 *   node ssh-mcp-server.js --host <IP> --port <PORT> --user <USER> --password <PASS>
 *   node ssh-mcp-server.js --host <IP> --port <PORT> --user <USER> --key-file <PATH>
 *
 * Options:
 *   --host       Server IP/hostname (required)
 *   --port       SSH port (default: 22)
 *   --user       SSH username (required)
 *   --password   SSH password (alternative to --key-file)
 *   --key-file   Path to private key file (alternative to --password)
 *   --passphrase Key passphrase (optional, for encrypted keys)
 *   --sudo       Execute commands with sudo (will prompt for sudo password if needed)
 */

const { spawn } = require('child_process');
const readline = require('readline');

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    acc[key] = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true;
  }
  return acc;
}, {});

const { host, port = '22', user, password, 'key-file': keyFile, 'sudo': sudoMode } = args;

if (!host || !user) {
  console.error(JSON.stringify({ error: 'Missing required arguments: --host and --user are required' }));
  process.exit(1);
}

// Parse port
const portNum = parseInt(port, 10);

// Build SSH command
function buildSSHCommand(command, useSudo = false) {
  const sshArgs = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-p', portNum.toString()
  ];

  if (keyFile) {
    sshArgs.push('-i', keyFile);
  }

  const target = `${user}@${host}`;

  if (useSudo || sudoMode === true) {
    // Use sudo -n to avoid interactive password prompt (relies on NOPASSWD sudo rule)
    return ['ssh', ...sshArgs, target, `sudo -n ${command}`];
  }

  return ['ssh', ...sshArgs, target, command];
}

// Execute SSH command
function executeCommand(command, useSudo = false) {
  return new Promise((resolve, reject) => {
    const [sshCmd, ...sshArgs] = buildSSHCommand(command, useSudo);

    const proc = spawn(sshCmd, sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

// MCP Protocol handling
// Read JSON messages from stdin, write responses to stdout
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Invalid JSON' }, id: null }) + '\n');
    return;
  }

  const { id, method, params } = request;

  try {
    if (method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ssh-server', version: '1.0.0' }
        }
      }) + '\n');
    }

    else if (method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'ssh_execute',
              description: 'Execute a shell command on the remote server via SSH',
              inputSchema: {
                type: 'object',
                properties: {
                  command: { type: 'string', description: 'Shell command to execute' },
                  sudo: { type: 'boolean', description: 'Run with sudo (default: false)', default: false },
                  timeout: { type: 'number', description: 'Timeout in seconds (default: 30)', default: 30 }
                },
                required: ['command']
              }
            },
            {
              name: 'ssh_upload',
              description: 'Upload a file to the remote server via SCP',
              inputSchema: {
                type: 'object',
                properties: {
                  localPath: { type: 'string', description: 'Local file path to upload' },
                  remotePath: { type: 'string', description: 'Destination path on remote server' },
                  sudo: { type: 'boolean', description: 'Use sudo on remote side (for protected paths)', default: false }
                },
                required: ['localPath', 'remotePath']
              }
            },
            {
              name: 'ssh_download',
              description: 'Download a file from the remote server via SCP',
              inputSchema: {
                type: 'object',
                properties: {
                  remotePath: { type: 'string', description: 'Path of file on remote server to download' },
                  localPath: { type: 'string', description: 'Local destination path' },
                  sudo: { type: 'boolean', description: 'Use sudo on remote side (for protected files)', default: false }
                },
                required: ['remotePath', 'localPath']
              }
            },
            {
              name: 'ssh_test',
              description: 'Test SSH connection and get server info (hostname, uptime, disk space)',
              inputSchema: {
                type: 'object',
                properties: {},
                required: []
              }
            }
          ]
        }
      }) + '\n');
    }

    else if (method === 'tools/call') {
      const { name, arguments: toolArgs } = params;

      if (name === 'ssh_execute') {
        const { command, sudo = false, timeout = 30 } = toolArgs;

        // Check for dangerous commands
        const dangerous = ['rm -rf /', 'dd if=', ':(){ :|:& };:', 'mkfs', 'fdisk', 'parted'];
        const isDangerous = dangerous.some(d => command.includes(d)) && !command.includes('--no-warnings');

        if (isDangerous) {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: `BLOCKED: Command contains potentially destructive operation. If you really need to run this, add '--no-warnings' suffix to confirm.`
              }]
            }
          }) + '\n');
          return;
        }

        const result = await Promise.race([
          executeCommand(command, sudo),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), timeout * 1000))
        ]);

        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: `EXIT_CODE: ${result.exitCode}\nSTDOUT:\n${result.stdout}${result.stderr ? '\nSTDERR:\n' + result.stderr : ''}`
            }]
          }
        }) + '\n');
      }

      else if (name === 'ssh_upload') {
        const { localPath, remotePath, sudo = false } = toolArgs;

        const dest = sudo ? `echo '${password}' | sudo -S scp -o StrictHostKeyChecking=no ${localPath} ${user}@${host}:${remotePath}` : `scp -o StrictHostKeyChecking=no ${localPath} ${user}@${host}:${remotePath}`;

        const proc = spawn('bash', ['-c', dest], { stdio: 'inherit' });

        proc.on('close', (code) => {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: code === 0 ? `Uploaded ${localPath} to ${remotePath}` : `Upload failed with exit code ${code}` }]
            }
          }) + '\n');
        });
      }

      else if (name === 'ssh_download') {
        const { remotePath, localPath, sudo = false } = toolArgs;

        const src = sudo ? `echo '${password}' | sudo -S scp -o StrictHostKeyChecking=no ${user}@${host}:${remotePath} ${localPath}` : `scp -o StrictHostKeyChecking=no ${user}@${host}:${remotePath} ${localPath}`;

        const proc = spawn('bash', ['-c', src], { stdio: 'inherit' });

        proc.on('close', (code) => {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: code === 0 ? `Downloaded ${remotePath} to ${localPath}` : `Download failed with exit code ${code}` }]
            }
          }) + '\n');
        });
      }

      else if (name === 'ssh_test') {
        const result = await executeCommand("echo 'CONNECTION_OK' && hostname && uptime && df -h / && free -h", false);

        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: result.stdout.includes('CONNECTION_OK')
                ? `SSH connection successful!\n\nServer Info:\n${result.stdout}`
                : `SSH connection failed: ${result.stderr || result.stdout}`
            }]
          }
        }) + '\n');
      }

      else {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${name}` }, id }) + '\n');
      }
    }

    else if (method === 'notifications/initialized') {
      // Client ready - no response needed
    }

    else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method}` }, id }) + '\n');
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err.message }
    }) + '\n');
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));