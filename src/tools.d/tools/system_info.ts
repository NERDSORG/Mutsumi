import { ITool, ToolContext } from '../interface';
import { resolveUri } from '../utils';
import {
    codepageToEncoding,
    detectWindowsCodepage,
    getToolVar,
    setToolVar,
} from '../cache';
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as cp from 'child_process';

function execCmd(cmd: string): string {
    try {
        // Synchronous execution for info gathering
        return cp.execSync(cmd, { timeout: 2000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
        return '';
    }
}

interface SystemInfoData {
    platform: string;
    release: string;
    arch: string;
    defaultShell: string;
    availableShells: string[];
    initSystem: string | null;
    distroInfo: string | null;
    systemPackageManagers: string[];
    languagePackageManagers: string[];
    serviceManager: string | null;
    containerTools: string[];
    codepage: number | null;
}

const SYSTEM_INFO_DATA_KEY = 'system_info.data';

async function detectSystemInfo(): Promise<SystemInfoData> {
    const platform = os.platform();
    const release = os.release();
    const arch = os.arch();
    const defaultShell = process.env.SHELL || (platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh');

    const shellCandidates = platform === 'win32'
        ? ['powershell', 'pwsh', 'cmd', 'bash'] // bash might exist via Git Bash
        : ['bash', 'zsh', 'fish', 'sh', 'csh', 'ksh'];

    const availableShells: string[] = [];
    for (const sh of shellCandidates) {
        try {
            // Use 'where' on Win32 (returns multiple lines sometimes) and 'which' on others
            const cmdStr = platform === 'win32' ? `where ${sh}` : `which ${sh}`;
            const result = execCmd(cmdStr);
            if (result) {
                // On Windows 'where' might return multiple paths, take the first non-empty one
                const paths = result.split(/[\r\n]+/);
                if (paths.length > 0 && paths[0].trim()) {
                    availableShells.push(`${sh}: ${paths[0].trim()}`);
                }
            }
        } catch (e) {}
    }

    let initSystem: string | null = null;
    let distroInfo: string | null = null;
    let systemPackageManagers: string[] = [];
    let serviceManager: string | null = null;

    if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
        // Init System
        const init = execCmd('ps -p 1 -o comm=') || execCmd('cat /proc/1/comm');
        if (init) initSystem = `${init.trim()} (Controls services via systemctl/service)`;

        // Distro
        const distro = execCmd('cat /etc/*release | grep PRETTY_NAME');
        if (distro) distroInfo = distro.replace(/PRETTY_NAME=/g, '').replace(/"/g, '');

        // System Package Managers
        const sysPMs = ['apt', 'apt-get', 'yum', 'dnf', 'pacman', 'zypper', 'apk', 'pkg'];
        systemPackageManagers = sysPMs.filter(pm => execCmd(`which ${pm}`));
    } else if (platform === 'darwin') {
        initSystem = 'launchd';
        if (execCmd('which brew')) {
            systemPackageManagers = ['homebrew'];
        }
    } else if (platform === 'win32') {
        // Windows System Package Managers
        const winSysPMs = ['choco', 'winget', 'scoop'];
        systemPackageManagers = winSysPMs.filter(pm => execCmd(`where ${pm}`));

        // Service Manager (Windows)
        // Windows uses the Service Control Manager (SCM). We check for common CLI tools to interact with it.
        const scmTools = [];
        if (execCmd('where sc')) scmTools.push('sc');
        if (execCmd('where net')) scmTools.push('net');
        serviceManager = `Windows SCM (CLI tools: ${scmTools.join(', ') || 'Powershell Get-Service'})`;
    }

    // Language Package Managers (Universal)
    const langPMs = ['npm', 'yarn', 'pnpm', 'pip', 'pip3', 'gem', 'cargo', 'rustup', 'go', 'composer', 'mvn', 'gradle'];
    const checkCmd = platform === 'win32' ? 'where' : 'which';
    const languagePackageManagers = langPMs.filter(pm => execCmd(`${checkCmd} ${pm}`));

    // Container & Virtualization Tools
    // Definition: [Display Name, CLI Command, { Platform: [Default Paths] }]
    const cvToolsDef: Array<[string, string, Record<string, string[]>]> = [
        ['docker', 'docker', {
            'win32': ['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'],
            'darwin': ['/Applications/Docker.app/Contents/Resources/bin/docker']
        }],
        ['podman', 'podman', {}],
        ['kubectl', 'kubectl', {}],
        ['minikube', 'minikube', {}],
        ['vagrant', 'vagrant', {}],
        ['wsl', 'wsl', {}],
        ['qemu', 'qemu-system-x86_64', {}],
        ['multipass', 'multipass', {}],
        ['lima', 'limactl', {}],
        ['helm', 'helm', {}],
        ['nerdctl', 'nerdctl', {}],
        ['virtualbox', 'VBoxManage', {
            'win32': ['C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe'],
            'darwin': ['/Applications/VirtualBox.app/Contents/MacOS/VBoxManage']
        }],
        ['vmware', 'vmrun', {
            'win32': [
                'C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe',
                'C:\\Program Files\\VMware\\VMware Workstation\\vmrun.exe'
            ],
            'darwin': ['/Applications/VMware Fusion.app/Contents/Library/vmrun']
        }]
    ];

    const checkCmdExists = (cmd: string) => {
        try {
            const check = platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
            cp.execSync(check, { stdio: 'ignore' });
            return true;
        } catch (e) { return false; }
    };

    const containerTools: string[] = [];
    for (const [name, cmd, paths] of cvToolsDef) {
        // 1. Check PATH
        if (checkCmdExists(cmd)) {
            containerTools.push(name);
            continue;
        }
        // 2. Check Default Paths for current platform
        if (paths[platform]) {
            for (const p of paths[platform]) {
                if (fs.existsSync(p)) {
                    containerTools.push(name);
                    break;
                }
            }
        }
    }

    // Detect Windows console code page via the shared cache utility.
    const codepage = detectWindowsCodepage();

    return {
        platform,
        release,
        arch,
        defaultShell,
        availableShells,
        initSystem,
        distroInfo,
        systemPackageManagers,
        languagePackageManagers,
        serviceManager,
        containerTools,
        codepage,
    };
}

function formatSystemInfo(data: SystemInfoData): string {
    let info = `Platform: ${data.platform} (${data.arch})\nRelease: ${data.release}`;

    if (data.codepage !== null) {
        const encoding = codepageToEncoding(data.codepage);
        info += `\nWindows Codepage: ${data.codepage}${encoding ? ` (${encoding})` : ''}`;
    }

    info += `\nDefault Shell (Env): ${data.defaultShell}`;

    if (data.availableShells.length > 0) {
        info += `\nAvailable Shells: ${data.availableShells.join(', ')}`;
    }

    if (data.initSystem) {
        info += `\nInit System: ${data.initSystem}`;
    }

    if (data.distroInfo) {
        info += `\nDistro Info: ${data.distroInfo}`;
    }

    if (data.systemPackageManagers.length > 0) {
        const label = data.platform === 'darwin' ? 'System Package Manager' : 'System Package Managers';
        info += `\n${label}: ${data.systemPackageManagers.join(', ')}`;
    }

    if (data.serviceManager) {
        info += `\nService Manager: ${data.serviceManager}`;
    }

    if (data.languagePackageManagers.length > 0) {
        info += `\nLanguage Package Managers: ${data.languagePackageManagers.join(', ')}`;
    }

    if (data.containerTools.length > 0) {
        info += `\nContainer & Virtualization: ${data.containerTools.join(', ')}`;
    }

    return info;
}

export const systemInfoTool: ITool = {
    name: 'system_info',
    definition: {
        name: 'system_info',
        description: 'Get system information (OS, Shell, Package Manager).',
        parameters: {
            type: 'object',
            properties: {},
            required: []
        }
    },
    execute: async (_args: any, _context: ToolContext) => {
        try {
            let data = getToolVar<SystemInfoData>(SYSTEM_INFO_DATA_KEY);
            if (!data) {
                data = await detectSystemInfo();
                setToolVar(SYSTEM_INFO_DATA_KEY, data);
            }
            return formatSystemInfo(data);
        } catch (err: any) {
            return `Error getting system info: ${err.message}`;
        }
    },
    prettyPrint: (_args: any) => {
        return `💻 Mutsumi checked system info`;
    }
    // shouldCache is intentionally omitted: the intermediate SystemInfoData is cached above,
    // so the formatted string can be regenerated cheaply without a second layer of caching.
};

export const getEnvVarTool: ITool = {
    name: 'get_env_var',
    definition: {
        name: 'get_env_var',
        description: 'Read the value of a specific system environment variable.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'The name of the environment variable (e.g. PATH, HOME).' }
            },
            required: ['name']
        }
    },
    execute: async (args: any, context: ToolContext) => {
        const key = args.name;
        if (!key) return 'Error: Please specify the environment variable name.';

        const value = process.env[key];
        if (value === undefined) {
            return `Environment variable '${key}' is not set.`;
        }
        return value;
    },
    prettyPrint: (args: any) => {
        return `🔧 Mutsumi read environment variable '${args.name || '(unknown)}'}`;
    }
};
