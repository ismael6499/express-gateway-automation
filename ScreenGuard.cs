using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace ScreenGuard {
    public class Program {
        private const string WINDOW_TITLE = "ScreenGuard_Hidden_Window";
        private const int WH_KEYBOARD_LL = 13;
        private const int WH_MOUSE_LL = 14;

        private const int WM_KEYDOWN = 0x0100;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_MOUSEMOVE = 0x0200;
        private const int WM_LBUTTONDOWN = 0x0201;
        private const int WM_RBUTTONDOWN = 0x0204;
        private const int WM_MBUTTONDOWN = 0x0207;

        private const int LLKHF_INJECTED = 0x00000010;
        private const int LLKHF_LOWER_IL_INJECTED = 0x00000002;
        private const int LLMHF_INJECTED = 0x00000001;
        private const int LLMHF_LOWER_IL_INJECTED = 0x00000002;

        private const int WM_SYSCOMMAND = 0x0112;
        private const int SC_MONITORPOWER = 0xF170;
        private static readonly IntPtr HWND_BROADCAST = new IntPtr(0xFFFF);

        private const int WM_POWERBROADCAST = 0x0218;
        private const int PBT_POWERSETTINGCHANGE = 0x8013;
        private const int DEVICE_NOTIFY_WINDOW_HANDLE = 0x00000000;

        private const int WM_USER = 0x0400;
        private const int WM_STOP_GUARD = WM_USER + 100;
        private const int WM_QUERY_STATUS = WM_USER + 101;

        private const int REMOTE_IDLE_TIMEOUT_SECONDS = 12;

        private static Guid GUID_CONSOLE_DISPLAY_STATE = new Guid("6FE69556-704A-47A0-8F24-C28D936F080C");
        private static Guid GUID_MONITOR_POWER_ON = new Guid("02731015-4510-4526-99E6-9598FE1E34B0");

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSLLHOOKSTRUCT {
            public POINT pt;
            public uint mouseData;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 4)]
        private struct POWERBROADCAST_SETTING {
            public Guid PowerSetting;
            public int DataLength;
            public int Data;
        }

        private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetConsoleWindow();

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        private const int SW_HIDE = 0;

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr RegisterPowerSettingNotification(IntPtr hRecipient, ref Guid PowerSettingGuid, int Flags);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnregisterPowerSettingNotification(IntPtr handle);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, uint dwExtraInfo);
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const byte VK_LCONTROL = 0xA2;

        private static IntPtr _kbdHook = IntPtr.Zero;
        private static IntPtr _mouseHook = IntPtr.Zero;
        private static LowLevelProc _kbdProcDelegate;
        private static LowLevelProc _mouseProcDelegate;

        private static IntPtr _powerNotify1 = IntPtr.Zero;
        private static IntPtr _powerNotify2 = IntPtr.Zero;

        private static bool _isGuarding = false;
        private static int _lastPhysX = -1;
        private static int _lastPhysY = -1;
        private static int _savedBrightness = -1;
        private static DateTime _guardStartTime = DateTime.MinValue;
        private static DateTime _lastRemoteInputTime = DateTime.MinValue;
        private static bool _remoteActivityActive = false;
        private static System.Windows.Forms.Timer _watchdogTimer;
        private static string _stateFile = "";

        private class HiddenMessageWindow : Form {
            public HiddenMessageWindow() {
                this.Text = WINDOW_TITLE;
                this.ShowInTaskbar = false;
                this.WindowState = FormWindowState.Minimized;
                this.FormBorderStyle = FormBorderStyle.None;
                this.Size = new Size(1, 1);
                this.Opacity = 0;
            }

            protected override void WndProc(ref Message m) {
                if (m.Msg == WM_STOP_GUARD) {
                    WakeUpAndExit("Comando remoto recibido (stop)");
                    m.Result = new IntPtr(1);
                    return;
                } else if (m.Msg == WM_QUERY_STATUS) {
                    m.Result = new IntPtr(_isGuarding ? 1 : 0);
                    return;
                } else if (m.Msg == WM_POWERBROADCAST && m.WParam.ToInt32() == PBT_POWERSETTINGCHANGE) {
                    POWERBROADCAST_SETTING ps = (POWERBROADCAST_SETTING)Marshal.PtrToStructure(m.LParam, typeof(POWERBROADCAST_SETTING));
                    if (ps.PowerSetting == GUID_CONSOLE_DISPLAY_STATE || ps.PowerSetting == GUID_MONITOR_POWER_ON) {
                        if (ps.Data != 0 && _isGuarding) {
                            double elapsedMs = (DateTime.Now - _guardStartTime).TotalMilliseconds;
                            if (elapsedMs > 500) {
                                bool isRecentRemote = _remoteActivityActive && (DateTime.Now - _lastRemoteInputTime).TotalSeconds < REMOTE_IDLE_TIMEOUT_SECONDS;
                                if (!isRecentRemote) {
                                    Log("Pantalla intentó encenderse por notificación o sistema sin interacción. Re-apagando...");
                                    ForceMonitorOff();
                                }
                            }
                        }
                    }
                }
                base.WndProc(ref m);
            }
        }

        private static HiddenMessageWindow _hiddenWindow;

        public static void Main(string[] args) {
            string cmd = args.Length > 0 ? args[0].ToLower().Trim() : "start";
            _stateFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "screenguard_state.json");

            if (cmd == "status") {
                IntPtr existingHwnd = FindWindow(null, WINDOW_TITLE);
                bool isActive = existingHwnd != IntPtr.Zero;
                int pid = 0;
                string details = "";
                if (isActive) {
                    try {
                        if (File.Exists(_stateFile)) {
                            string content = File.ReadAllText(_stateFile);
                            Console.WriteLine(content);
                            return;
                        }
                    } catch {}
                }
                Console.WriteLine("{{\"active\":{0},\"pid\":{1},\"details\":\"{2}\"}}", isActive ? "true" : "false", pid, details);
                return;
            }

            if (cmd == "stop") {
                IntPtr existingHwnd = FindWindow(null, WINDOW_TITLE);
                if (existingHwnd != IntPtr.Zero) {
                    SendMessage(existingHwnd, (uint)WM_STOP_GUARD, IntPtr.Zero, IntPtr.Zero);
                    Console.WriteLine("{\"status\":\"ok\",\"message\":\"Señal de detención enviada a ScreenGuard.\"}");
                } else {
                    WakeMonitorDirect();
                    RestoreBrightnessFromFile();
                    Console.WriteLine("{\"status\":\"ok\",\"message\":\"ScreenGuard no estaba activo. Pantalla encendida directamente.\"}");
                }
                UpdateStateFile(false, "Detenido manualmente");
                return;
            }

            IntPtr consoleWnd = GetConsoleWindow();
            if (consoleWnd != IntPtr.Zero) {
                ShowWindow(consoleWnd, SW_HIDE);
            }

            bool createdNew;
            using (Mutex mutex = new Mutex(true, "Global\\ScreenGuard_Unique_Mutex", out createdNew)) {
                if (!createdNew) {
                    IntPtr existingHwnd = FindWindow(null, WINDOW_TITLE);
                    if (existingHwnd != IntPtr.Zero) {
                        ForceMonitorOff();
                        Console.WriteLine("{\"status\":\"ok\",\"message\":\"ScreenGuard ya estaba en ejecución. Monitor re-apagado.\"}");
                        return;
                    }
                }

                RunGuard();
            }
        }

        private static void RunGuard() {
            Log("Iniciando ScreenGuard. Guardando brillo y activando protección de pantalla...");
            _guardStartTime = DateTime.Now;
            _isGuarding = true;
            _remoteActivityActive = false;

            // Leer y guardar el nivel de brillo actual antes de reducir a 0%
            _savedBrightness = GetBrightness();
            if (_savedBrightness > 0) {
                Log(string.Format("Brillo original detectado: {0}%. Reduciendo brillo a 0% para penumbra física...", _savedBrightness));
                SetBrightness(0);
            }

            Point curPos = Cursor.Position;
            _lastPhysX = curPos.X;
            _lastPhysY = curPos.Y;

            UpdateStateFile(true, "Protección activa");

            _hiddenWindow = new HiddenMessageWindow();
            IntPtr hWnd = _hiddenWindow.Handle;

            _powerNotify1 = RegisterPowerSettingNotification(hWnd, ref GUID_CONSOLE_DISPLAY_STATE, DEVICE_NOTIFY_WINDOW_HANDLE);
            _powerNotify2 = RegisterPowerSettingNotification(hWnd, ref GUID_MONITOR_POWER_ON, DEVICE_NOTIFY_WINDOW_HANDLE);

            using (Process curProcess = Process.GetCurrentProcess())
            using (ProcessModule curModule = curProcess.MainModule) {
                IntPtr hMod = GetModuleHandle(curModule.ModuleName);
                _kbdProcDelegate = KeyboardHookCallback;
                _mouseProcDelegate = MouseHookCallback;

                _kbdHook = SetWindowsHookEx(WH_KEYBOARD_LL, _kbdProcDelegate, hMod, 0);
                _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProcDelegate, hMod, 0);
            }

            // Watchdog cada 1 segundo para auto-reapagar tras inactividad remota
            _watchdogTimer = new System.Windows.Forms.Timer();
            _watchdogTimer.Interval = 1000;
            _watchdogTimer.Tick += (s, e) => {
                if (!_isGuarding) return;

                if (_remoteActivityActive) {
                    double idleSec = (DateTime.Now - _lastRemoteInputTime).TotalSeconds;
                    if (idleSec >= REMOTE_IDLE_TIMEOUT_SECONDS) {
                        Log(string.Format("Inactividad remota detectada ({0}s). Re-apagando pantalla física automáticamente...", (int)idleSec));
                        _remoteActivityActive = false;
                        ForceMonitorOff();
                    }
                }
            };
            _watchdogTimer.Start();

            ForceMonitorOff();
            Console.WriteLine("{{\"status\":\"ok\",\"message\":\"ScreenGuard iniciado con éxito. PID: {0}\"}}", Process.GetCurrentProcess().Id);

            Application.Run(_hiddenWindow);

            Cleanup();
        }

        private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
            if (nCode >= 0 && _isGuarding) {
                KBDLLHOOKSTRUCT kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                bool isInjected = (kb.flags & LLKHF_INJECTED) != 0 || (kb.flags & LLKHF_LOWER_IL_INJECTED) != 0;

                if (isInjected) {
                    // Entrada remota (Google Remote Desktop / ScreenConnect)
                    _lastRemoteInputTime = DateTime.Now;
                    _remoteActivityActive = true;
                    return CallNextHookEx(_kbdHook, nCode, wParam, lParam);
                } else {
                    // TECLA FÍSICA REAL EN LA COMPUTADORA -> DESACTIVA EL GUARDIÁN Y DESPIERTA PANTALLA
                    int msg = wParam.ToInt32();
                    if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN) {
                        double elapsedMs = (DateTime.Now - _guardStartTime).TotalMilliseconds;
                        if (elapsedMs > 500) {
                            WakeUpAndExit(string.Format("Tecla física presionada (VK: 0x{0:X2})", kb.vkCode));
                        }
                    }
                }
            }
            return CallNextHookEx(_kbdHook, nCode, wParam, lParam);
        }

        private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
            if (nCode >= 0 && _isGuarding) {
                MSLLHOOKSTRUCT ms = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                bool isInjected = (ms.flags & LLMHF_INJECTED) != 0 || (ms.flags & LLMHF_LOWER_IL_INJECTED) != 0;

                if (isInjected) {
                    // MOUSE REMOTO (Google Remote Desktop / ScreenConnect / AnyDesk)
                    _lastRemoteInputTime = DateTime.Now;
                    _remoteActivityActive = true;
                    return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
                } else {
                    // MOUSE FÍSICO REAL EN LA COMPUTADORA -> DESACTIVA EL GUARDIÁN Y DESPIERTA PANTALLA
                    int msg = wParam.ToInt32();
                    double elapsedMs = (DateTime.Now - _guardStartTime).TotalMilliseconds;
                    if (elapsedMs > 500) {
                        if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN) {
                            WakeUpAndExit("Click de mouse físico detectado");
                        } else if (msg == WM_MOUSEMOVE) {
                            if (_lastPhysX != -1 && _lastPhysY != -1) {
                                int dist = Math.Abs(ms.pt.x - _lastPhysX) + Math.Abs(ms.pt.y - _lastPhysY);
                                if (dist > 12) {
                                    WakeUpAndExit(string.Format("Movimiento de mouse físico detectado ({0}px)", dist));
                                }
                            }
                            _lastPhysX = ms.pt.x;
                            _lastPhysY = ms.pt.y;
                        }
                    }
                }
            }
            return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
        }

        private static void ForceMonitorOff() {
            PostMessage(HWND_BROADCAST, (uint)WM_SYSCOMMAND, (IntPtr)SC_MONITORPOWER, (IntPtr)2);
        }

        private static void WakeMonitorDirect() {
            PostMessage(HWND_BROADCAST, (uint)WM_SYSCOMMAND, (IntPtr)SC_MONITORPOWER, (IntPtr)(-1));
            keybd_event(VK_LCONTROL, 0, 0, 0);
            keybd_event(VK_LCONTROL, 0, KEYEVENTF_KEYUP, 0);
        }

        private static void WakeUpAndExit(string reason) {
            if (!_isGuarding) return;
            _isGuarding = false;
            Log(string.Format("Despertando pantalla y desactivando Guardián. Motivo: {0}", reason));

            UnhookHooks();

            // Restaurar brillo original si fue modificado
            if (_savedBrightness >= 0) {
                Log(string.Format("Restaurando brillo de pantalla a su nivel original: {0}%...", _savedBrightness));
                SetBrightness(_savedBrightness);
            }

            WakeMonitorDirect();
            UpdateStateFile(false, reason);

            if (_hiddenWindow != null && !_hiddenWindow.IsDisposed) {
                _hiddenWindow.BeginInvoke((MethodInvoker)delegate {
                    Application.ExitThread();
                });
            }
        }

        private static int GetBrightness() {
            try {
                using (ManagementClass mc = new ManagementClass("root/WMI", "WmiMonitorBrightness", null))
                using (ManagementObjectCollection moc = mc.GetInstances()) {
                    foreach (ManagementObject mo in moc) {
                        return Convert.ToInt32(mo["CurrentBrightness"]);
                    }
                }
            } catch (Exception ex) {
                Log("Aviso al obtener brillo WMI: " + ex.Message);
            }
            return -1;
        }

        private static void SetBrightness(int level) {
            try {
                if (level < 0) level = 0;
                if (level > 100) level = 100;
                using (ManagementClass mc = new ManagementClass("root/WMI", "WmiMonitorBrightnessMethods", null))
                using (ManagementObjectCollection moc = mc.GetInstances()) {
                    foreach (ManagementObject mo in moc) {
                        mo.InvokeMethod("WmiSetBrightness", new object[] { 1, level });
                        break;
                    }
                }
            } catch (Exception ex) {
                Log("Aviso al ajustar brillo WMI: " + ex.Message);
            }
        }

        private static void RestoreBrightnessFromFile() {
            try {
                if (File.Exists(_stateFile)) {
                    string content = File.ReadAllText(_stateFile);
                    int idx = content.IndexOf("\"savedBrightness\":");
                    if (idx != -1) {
                        string sub = content.Substring(idx + 18);
                        int end = sub.IndexOfAny(new char[] { ',', '}', ' ' });
                        if (end != -1) {
                            int b = int.Parse(sub.Substring(0, end).Trim());
                            if (b >= 0) {
                                SetBrightness(b);
                            }
                        }
                    }
                }
            } catch {}
        }

        private static void UnhookHooks() {
            if (_watchdogTimer != null) {
                _watchdogTimer.Stop();
                _watchdogTimer.Dispose();
                _watchdogTimer = null;
            }
            if (_kbdHook != IntPtr.Zero) {
                UnhookWindowsHookEx(_kbdHook);
                _kbdHook = IntPtr.Zero;
            }
            if (_mouseHook != IntPtr.Zero) {
                UnhookWindowsHookEx(_mouseHook);
                _mouseHook = IntPtr.Zero;
            }
            if (_powerNotify1 != IntPtr.Zero) {
                UnregisterPowerSettingNotification(_powerNotify1);
                _powerNotify1 = IntPtr.Zero;
            }
            if (_powerNotify2 != IntPtr.Zero) {
                UnregisterPowerSettingNotification(_powerNotify2);
                _powerNotify2 = IntPtr.Zero;
            }
        }

        private static void Cleanup() {
            UnhookHooks();
            UpdateStateFile(false, "Finalizado");
        }

        private static void UpdateStateFile(bool active, string details) {
            try {
                string json = string.Format(
                    "{{\"active\":{0},\"pid\":{1},\"savedBrightness\":{2},\"details\":\"{3}\",\"updated\":\"{4}\"}}",
                    active ? "true" : "false",
                    Process.GetCurrentProcess().Id,
                    _savedBrightness,
                    details.Replace("\"", "'"),
                    DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss")
                );
                File.WriteAllText(_stateFile, json);
            } catch {}
        }

        private static void Log(string msg) {
            try {
                string logPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "gateway_server.log");
                string line = string.Format("[{0:HH:mm:ss}] [ScreenGuard] {1}", DateTime.Now, msg);
                File.AppendAllText(logPath, line + Environment.NewLine);
            } catch {}
        }
    }
}
