#!/usr/bin/env bun
/**
 * Lightweight CLI client for agent-browser
 * 
 * This file contains ONLY the client logic (no Playwright imports).
 * It can be compiled with Bun for fast startup times.
 * 
 * The actual browser automation runs in a separate daemon process.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

// ============================================================================
// Configuration
// ============================================================================

const SESSION = process.env.AGENT_BROWSER_SESSION || 'default';
const SOCKET_PATH = path.join(os.tmpdir(), `agent-browser-${SESSION}.sock`);
const PID_FILE = path.join(os.tmpdir(), `agent-browser-${SESSION}.pid`);

// ============================================================================
// Daemon Management
// ============================================================================

function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (isDaemonRunning() && fs.existsSync(SOCKET_PATH)) {
    return;
  }

  // Find the daemon script - look relative to this script
  const scriptDir = path.dirname(process.argv[1]);
  let daemonPath = path.join(scriptDir, 'daemon.js');
  
  // Fallback paths
  if (!fs.existsSync(daemonPath)) {
    daemonPath = path.join(scriptDir, '../dist/daemon.js');
  }
  if (!fs.existsSync(daemonPath)) {
    daemonPath = path.join(process.cwd(), 'dist/daemon.js');
  }
  
  if (!fs.existsSync(daemonPath)) {
    throw new Error(`Daemon not found. Looked in: ${daemonPath}`);
  }

  const child = spawn('node', [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: SESSION },
  });
  child.unref();

  // Wait for socket
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(SOCKET_PATH)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Failed to start daemon');
}

// ============================================================================
// Command Execution
// ============================================================================

interface Response {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

async function sendCommand(cmd: Record<string, unknown>): Promise<Response> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let resolved = false;
    const socket = net.createConnection(SOCKET_PATH);

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.on('connect', () => {
      socket.write(JSON.stringify(cmd) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1 && !resolved) {
        resolved = true;
        try {
          const response = JSON.parse(buffer.substring(0, idx)) as Response;
          cleanup();
          resolve(response);
        } catch {
          cleanup();
          reject(new Error('Invalid JSON response'));
        }
      }
    });

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(err);
      }
    });

    socket.on('close', () => {
      if (!resolved && buffer.trim()) {
        resolved = true;
        try {
          resolve(JSON.parse(buffer.trim()) as Response);
        } catch {
          reject(new Error('Connection closed'));
        }
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('Timeout'));
      }
    }, 15000);
  });
}

// ============================================================================
// CLI Parsing
// ============================================================================

function parseArgs(args: string[]): { cmd: Record<string, unknown> | null; json: boolean } {
  const json = args.includes('--json');
  const cleanArgs = args.filter(a => !a.startsWith('--'));
  
  if (cleanArgs.length === 0) return { cmd: null, json };
  
  const command = cleanArgs[0];
  const rest = cleanArgs.slice(1);
  const id = Math.random().toString(36).slice(2, 10);

  switch (command) {
    case 'open':
    case 'goto':
    case 'navigate':
      return { cmd: { id, action: 'navigate', url: rest[0]?.startsWith('http') ? rest[0] : `https://${rest[0]}` }, json };
    
    case 'click':
      return { cmd: { id, action: 'click', selector: rest[0] }, json };
    
    case 'fill':
      return { cmd: { id, action: 'fill', selector: rest[0], value: rest.slice(1).join(' ') }, json };
    
    case 'type':
      return { cmd: { id, action: 'type', selector: rest[0], text: rest.slice(1).join(' ') }, json };
    
    case 'hover':
      return { cmd: { id, action: 'hover', selector: rest[0] }, json };
    
    case 'snapshot':
      return { cmd: { id, action: 'snapshot' }, json };
    
    case 'screenshot':
      return { cmd: { id, action: 'screenshot', path: rest[0] }, json };
    
    case 'close':
    case 'quit':
      return { cmd: { id, action: 'close' }, json };
    
    case 'get':
      if (rest[0] === 'text') return { cmd: { id, action: 'gettext', selector: rest[1] }, json };
      if (rest[0] === 'url') return { cmd: { id, action: 'url' }, json };
      if (rest[0] === 'title') return { cmd: { id, action: 'title' }, json };
      return { cmd: null, json };
    
    case 'press':
      return { cmd: { id, action: 'press', key: rest[0] }, json };
    
    case 'wait':
      if (/^\d+$/.test(rest[0])) {
        return { cmd: { id, action: 'wait', timeout: parseInt(rest[0], 10) }, json };
      }
      return { cmd: { id, action: 'wait', selector: rest[0] }, json };
    
    case 'back':
      return { cmd: { id, action: 'back' }, json };
    
    case 'forward':
      return { cmd: { id, action: 'forward' }, json };
    
    case 'reload':
      return { cmd: { id, action: 'reload' }, json };
    
    case 'eval':
      return { cmd: { id, action: 'evaluate', script: rest.join(' ') }, json };

    default:
      return { cmd: null, json };
  }
}

// ============================================================================
// Output Formatting
// ============================================================================

function printResponse(response: Response, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(response));
    return;
  }

  if (!response.success) {
    console.error('\x1b[31m✗ Error:\x1b[0m', response.error);
    process.exit(1);
  }

  const data = response.data as Record<string, unknown>;

  if (data?.url && data?.title) {
    console.log('\x1b[32m✓\x1b[0m', '\x1b[1m' + data.title + '\x1b[0m');
    console.log('\x1b[2m  ' + data.url + '\x1b[0m');
  } else if (data?.snapshot) {
    console.log(data.snapshot);
  } else if (data?.text !== undefined) {
    console.log(data.text);
  } else if (data?.url) {
    console.log(data.url);
  } else if (data?.title) {
    console.log(data.title);
  } else if (data?.result !== undefined) {
    console.log(typeof data.result === 'object' ? JSON.stringify(data.result, null, 2) : data.result);
  } else if (data?.closed) {
    console.log('\x1b[32m✓\x1b[0m Browser closed');
  } else {
    console.log('\x1b[32m✓\x1b[0m Done');
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
agent-browser - fast browser automation CLI

Usage: agent-browser <command> [args] [--json]

Commands:
  open <url>              Navigate to URL
  click <sel>             Click element (use @ref from snapshot)
  fill <sel> <text>       Fill input
  type <sel> <text>       Type text
  hover <sel>             Hover element
  snapshot                Get accessibility tree with refs
  screenshot [path]       Take screenshot
  get text <sel>          Get text content
  get url                 Get current URL
  get title               Get page title
  press <key>             Press keyboard key
  wait <ms|sel>           Wait for time or element
  eval <js>               Evaluate JavaScript
  close                   Close browser

Options:
  --json                  Output JSON (for AI agents)

Examples:
  agent-browser open example.com
  agent-browser snapshot
  agent-browser click @e2
  agent-browser fill @e3 "hello"
`);
    process.exit(0);
  }

  const { cmd, json } = parseArgs(args);
  
  if (!cmd) {
    console.error('\x1b[31mUnknown command\x1b[0m');
    process.exit(1);
  }

  try {
    await ensureDaemon();
    const response = await sendCommand(cmd);
    printResponse(response, json);
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ success: false, error: message }));
    } else {
      console.error('\x1b[31m✗ Error:\x1b[0m', message);
    }
    process.exit(1);
  }
}

main();
