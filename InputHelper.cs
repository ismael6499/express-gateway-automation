using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace InputHelper {
    public class Program {
        [DllImport("user32.dll")]
        private static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);

        private const uint MOUSEEVENTF_MOVE = 0x0001;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;

        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        private struct INPUTDATA {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT {
            public uint type;
            public INPUTDATA data;
        }

        private const uint INPUT_MOUSE = 0;
        private const uint INPUT_KEYBOARD = 1;
        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);

        private static System.Threading.Timer watchdogTimer = null;
        private static readonly object watchdogLock = new object();

        private static void ArmWatchdog(int ms = 450) {
            lock (watchdogLock) {
                if (watchdogTimer == null) {
                    watchdogTimer = new System.Threading.Timer((s) => {
                        try { ReleaseAllModifiers(); } catch { }
                    }, null, ms, Timeout.Infinite);
                } else {
                    watchdogTimer.Change(ms, Timeout.Infinite);
                }
            }
        }

        private static bool IsExtendedKey(byte vk) {
            return vk == 0x5B || vk == 0x5C || vk == 0xA3 || vk == 0xA5 ||
                   vk == 0x2D || vk == 0x2E || vk == 0x24 || vk == 0x23 ||
                   vk == 0x21 || vk == 0x22 || (vk >= 0x25 && vk <= 0x28);
        }

        private static void SendKeyDown(byte vk) {
            uint scan = MapVirtualKey((uint)vk, 0);
            uint flags = 0;
            if (IsExtendedKey(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
            keybd_event(vk, (byte)scan, flags, UIntPtr.Zero);
        }

        private static void SendKeyUp(byte vk) {
            uint scan = MapVirtualKey((uint)vk, 0);
            uint flags = KEYEVENTF_KEYUP;
            if (IsExtendedKey(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
            keybd_event(vk, (byte)scan, flags, UIntPtr.Zero);
        }

        public static void ReleaseAllModifiers() {
            byte[] modKeys = new byte[] {
                0x11, 0xA2, 0xA3,
                0x12, 0xA4, 0xA5,
                0x10, 0xA0, 0xA1,
                0x5B, 0x5C
            };
            foreach (byte vk in modKeys) {
                SendKeyUp(vk);
            }
        }

        public static void Main(string[] args) {
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;

            if (args.Length > 0 && args[0] == "--pipe") {
                RunPipeLoop();
                return;
            }

            if (args.Length > 0) {
                ExecuteCommand(string.Join(" ", args));
                return;
            }

            Console.WriteLine("Usage: InputHelper.exe --pipe | <command> [args]");
        }

        private static void RunPipeLoop() {
            Console.WriteLine("READY");
            string line;
            while ((line = Console.ReadLine()) != null) {
                line = line.Trim();
                if (string.IsNullOrEmpty(line)) continue;
                if (line.Equals("exit", StringComparison.OrdinalIgnoreCase) || line.Equals("quit", StringComparison.OrdinalIgnoreCase)) {
                    break;
                }
                if (line.Equals("ping", StringComparison.OrdinalIgnoreCase)) {
                    Console.WriteLine("PONG");
                    continue;
                }

                try {
                    ExecuteCommand(line);
                    Console.WriteLine("OK");
                } catch (Exception ex) {
                    Console.WriteLine("ERR " + ex.Message);
                }
            }
        }

        private static void ExecuteCommand(string cmdLine) {
            if (string.IsNullOrEmpty(cmdLine)) return;
            string[] parts = cmdLine.Split(new char[] { ' ' }, 2);
            string action = parts[0].ToLowerInvariant();
            string rest = parts.Length > 1 ? parts[1].Trim() : "";

            switch (action) {
                case "m":
                case "move":
                    MouseMove(rest);
                    break;
                case "c":
                case "click":
                    MouseClick(rest);
                    break;
                case "dc":
                case "doubleclick":
                case "double-click":
                    MouseDoubleClick(rest);
                    break;
                case "d":
                case "down":
                    MouseDown(rest);
                    break;
                case "u":
                case "up":
                    MouseUp(rest);
                    break;
                case "s":
                case "scroll":
                    MouseScroll(rest);
                    break;
                case "t":
                case "type":
                case "text":
                    TypeText(rest);
                    break;
                case "k":
                case "key":
                    PressKey(rest);
                    break;
                case "r":
                case "reset":
                case "release":
                    ReleaseAllModifiers();
                    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                    mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
                    mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, UIntPtr.Zero);
                    break;
                default:
                    throw new ArgumentException("Unknown action: " + action);
            }
        }

        private static void MouseMove(string args) {
            string[] coords = args.Split(new char[] { ' ', ',' }, StringSplitOptions.RemoveEmptyEntries);
            if (coords.Length < 2) return;
            int dx, dy;
            if (int.TryParse(coords[0], out dx) && int.TryParse(coords[1], out dy)) {
                mouse_event(MOUSEEVENTF_MOVE, dx, dy, 0, UIntPtr.Zero);
            }
        }

        private static void MouseClick(string btn) {
            btn = (btn ?? "").ToLowerInvariant();
            if (btn == "right" || btn == "r") {
                mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(10);
                mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
            } else if (btn == "middle" || btn == "m") {
                mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(10);
                mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, UIntPtr.Zero);
            } else {
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(10);
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            }
        }

        private static void MouseDoubleClick(string btn) {
            MouseClick(btn);
            Thread.Sleep(80);
            MouseClick(btn);
        }

        private static void MouseDown(string btn) {
            btn = (btn ?? "").ToLowerInvariant();
            if (btn == "right" || btn == "r") {
                mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
            } else if (btn == "middle" || btn == "m") {
                mouse_event(MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0, UIntPtr.Zero);
            } else {
                mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
            }
        }

        private static void MouseUp(string btn) {
            btn = (btn ?? "").ToLowerInvariant();
            if (btn == "right" || btn == "r") {
                mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
            } else if (btn == "middle" || btn == "m") {
                mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, UIntPtr.Zero);
            } else {
                mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
            }
        }

        private static void MouseScroll(string delta) {
            int d;
            if (int.TryParse(delta, out d)) {
                mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)d, UIntPtr.Zero);
            }
        }

        private static void TypeText(string text) {
            if (string.IsNullOrEmpty(text)) return;
            int len = text.Length;
            INPUT[] inputs = new INPUT[len * 2];
            int structSize = Marshal.SizeOf(typeof(INPUT));

            for (int i = 0; i < len; i++) {
                char c = text[i];
                // Key down
                inputs[i * 2] = new INPUT {
                    type = INPUT_KEYBOARD,
                    data = new INPUTDATA {
                        ki = new KEYBDINPUT {
                            wVk = 0,
                            wScan = (ushort)c,
                            dwFlags = KEYEVENTF_UNICODE,
                            time = 0,
                            dwExtraInfo = IntPtr.Zero
                        }
                    }
                };
                // Key up
                inputs[i * 2 + 1] = new INPUT {
                    type = INPUT_KEYBOARD,
                    data = new INPUTDATA {
                        ki = new KEYBDINPUT {
                            wVk = 0,
                            wScan = (ushort)c,
                            dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                            time = 0,
                            dwExtraInfo = IntPtr.Zero
                        }
                    }
                };
            }

            SendInput((uint)inputs.Length, inputs, structSize);
        }

        private static readonly Dictionary<string, byte> KeyMap = new Dictionary<string, byte>(StringComparer.OrdinalIgnoreCase) {
            { "enter", 0x0D }, { "return", 0x0D },
            { "esc", 0x1B }, { "escape", 0x1B },
            { "backspace", 0x08 }, { "bksp", 0x08 },
            { "tab", 0x09 },
            { "space", 0x20 },
            { "delete", 0x2E }, { "del", 0x2E },
            { "insert", 0x2D }, { "ins", 0x2D },
            { "home", 0x24 },
            { "end", 0x23 },
            { "pageup", 0x21 }, { "pgup", 0x21 }, { "repag", 0x21 },
            { "pagedown", 0x22 }, { "pgdn", 0x22 }, { "avpag", 0x22 },
            { "up", 0x26 }, { "arrowup", 0x26 },
            { "down", 0x28 }, { "arrowdown", 0x28 },
            { "left", 0x25 }, { "arrowleft", 0x25 },
            { "right", 0x27 }, { "arrowright", 0x27 },
            { "win", 0x5B }, { "windows", 0x5B }, { "lwin", 0x5B },
            { "ctrl", 0x11 }, { "control", 0x11 },
            { "alt", 0x12 }, { "menu", 0x12 },
            { "shift", 0x10 },
            { "capslock", 0x14 },
            { "printscreen", 0x2C }, { "prtscn", 0x2C }, { "prntscrn", 0x2C },
            { "scrolllock", 0x91 },
            { "pause", 0x13 },
            { "f1", 0x70 }, { "f2", 0x71 }, { "f3", 0x72 }, { "f4", 0x73 },
            { "f5", 0x74 }, { "f6", 0x75 }, { "f7", 0x76 }, { "f8", 0x77 },
            { "f9", 0x78 }, { "f10", 0x79 }, { "f11", 0x7A }, { "f12", 0x7B }
        };

        private static void PressKey(string keyExpr) {
            if (string.IsNullOrEmpty(keyExpr)) return;
            string[] parts = keyExpr.Split(new char[] { '+', '-', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            List<byte> modifiersToRelease = new List<byte>();
            List<byte> mainKeys = new List<byte>();

            // Arm safety watchdog to auto-release any modifier keys after 450ms
            ArmWatchdog(450);

            try {
                for (int i = 0; i < parts.Length; i++) {
                    string p = parts[i].Trim().ToLowerInvariant();
                    if (string.IsNullOrEmpty(p)) continue;

                    if (p == "ctrl" || p == "control") {
                        SendKeyDown(0x11);
                        modifiersToRelease.Add(0x11);
                    } else if (p == "alt") {
                        SendKeyDown(0x12);
                        modifiersToRelease.Add(0x12);
                    } else if (p == "shift") {
                        SendKeyDown(0x10);
                        modifiersToRelease.Add(0x10);
                    } else if (p == "win" || p == "windows" || p == "lwin") {
                        SendKeyDown(0x5B);
                        modifiersToRelease.Add(0x5B);
                    } else {
                        if (KeyMap.ContainsKey(p)) {
                            mainKeys.Add(KeyMap[p]);
                        } else if (p.Length == 1) {
                            char c = p[0];
                            if (c >= 'a' && c <= 'z') mainKeys.Add((byte)('A' + (c - 'a')));
                            else if (c >= '0' && c <= '9') mainKeys.Add((byte)c);
                        }
                    }
                }

                if (mainKeys.Count > 0) {
                    Thread.Sleep(15);
                    foreach (byte k in mainKeys) {
                        SendKeyDown(k);
                    }
                    Thread.Sleep(30);
                    for (int i = mainKeys.Count - 1; i >= 0; i--) {
                        SendKeyUp(mainKeys[i]);
                    }
                    Thread.Sleep(15);
                } else if (modifiersToRelease.Count > 0) {
                    // If only modifier(s) were pressed (e.g. Win key or Alt key alone)
                    Thread.Sleep(40);
                }
            } finally {
                // ALWAYS release specific modifiers in reverse order
                for (int i = modifiersToRelease.Count - 1; i >= 0; i--) {
                    SendKeyUp(modifiersToRelease[i]);
                }
                // Complete safety sweep: ensure all modifier variants (L/R) are released
                ReleaseAllModifiers();
            }
        }
    }
}
