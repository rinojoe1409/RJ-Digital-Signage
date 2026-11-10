using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("RJ Digital Signage Player")]
[assembly: AssemblyDescription("Player Windows RJ Digital Signage System")]
[assembly: AssemblyCompany("Rino Joe")]
[assembly: AssemblyProduct("RJ Digital Signage Player")]
[assembly: AssemblyCopyright("Copyright ©2026 Rino Joe")]
[assembly: AssemblyVersion("0.3.2.0")]
[assembly: AssemblyFileVersion("0.3.2.0")]

namespace RJSignagePlayer
{
    internal sealed class Options
    {
        public string InstallDirectory = AppDomain.CurrentDomain.BaseDirectory;
        public string DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RJ Digital Signage Player", "data");
        public string MediaDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Content RJ Digital");
        public bool Settings, Autostart, Shutdown, Headless, Diagnose;
        public string DiagnosticResult;
        public string NodePath { get { return Path.Combine(InstallDirectory, "runtime", "node.exe"); } }
        public string AgentPath { get { return Path.Combine(InstallDirectory, "player", "agent.mjs"); } }
        public string ConfigPath { get { return Path.Combine(DataDirectory, "config.json"); } }
        public static Options Parse(string[] args)
        {
            Options options = new Options();
            bool customDataDirectory = false, customMediaDirectory = false;
            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--settings": options.Settings = true; break;
                    case "--autostart": options.Autostart = true; break;
                    case "--shutdown": options.Shutdown = true; break;
                    case "--headless": options.Headless = true; break;
                    case "--diagnose": case "--self-test": options.Diagnose = true; break;
                    case "--data-dir": if (++i >= args.Length) throw new ArgumentException("Lokasi data belum diisi."); options.DataDirectory = Path.GetFullPath(args[i]); customDataDirectory = true; break;
                    case "--media-dir": if (++i >= args.Length) throw new ArgumentException("Lokasi konten belum diisi."); options.MediaDirectory = Path.GetFullPath(args[i]); customMediaDirectory = true; break;
                    case "--diagnostic-result": if (++i >= args.Length) throw new ArgumentException("Lokasi hasil belum diisi."); options.DiagnosticResult = Path.GetFullPath(args[i]); options.Diagnose = true; break;
                    default: throw new ArgumentException("Pilihan aplikasi tidak dikenal.");
                }
            }
            if (customDataDirectory && !customMediaDirectory) options.MediaDirectory = Path.Combine(options.DataDirectory, "media");
            options.DataDirectory = Path.GetFullPath(options.DataDirectory);
            options.MediaDirectory = Path.GetFullPath(options.MediaDirectory);
            return options;
        }
        public string InstanceName
        {
            get
            {
                using (SHA256 hash = SHA256.Create())
                {
                    string identity = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value + "|" + DataDirectory.ToUpperInvariant();
                    string suffix = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "").Substring(0, 24);
                    return "Local\\RJDigitalSignagePlayer-" + suffix;
                }
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Options options;
            try { options = Options.Parse(args); }
            catch (Exception error)
            {
                bool nonInteractive = Array.IndexOf(args, "--headless") >= 0 || Array.IndexOf(args, "--self-test") >= 0 || Array.IndexOf(args, "--diagnose") >= 0 || Array.IndexOf(args, "--diagnostic-result") >= 0 || Array.IndexOf(args, "--shutdown") >= 0;
                if (nonInteractive) Console.Error.WriteLine("RJ Player: pilihan aplikasi tidak valid.");
                else MessageBox.Show(error.Message, "RJ Player", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 2;
            }
            try
            {
                if (options.Diagnose) return Diagnose(options);
                if (options.Shutdown) return StopExisting(options);
                return RunApplication(options);
            }
            catch
            {
                const string error = "RJ Player belum dapat dimulai. Periksa pemasangan aplikasi dan folder data.";
                if (options.Headless || options.Diagnose || options.Shutdown) Console.Error.WriteLine(error);
                else MessageBox.Show(error, "RJ Player", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
        private static int RunApplication(Options options)
        {
            bool created;
            MutexSecurity mutexSecurity = new MutexSecurity();
            mutexSecurity.SetAccessRuleProtection(true, false);
            mutexSecurity.AddAccessRule(new MutexAccessRule(WindowsIdentity.GetCurrent().User, MutexRights.FullControl, AccessControlType.Allow));
            mutexSecurity.AddAccessRule(new MutexAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), MutexRights.FullControl, AccessControlType.Allow));
            using (Mutex instance = new Mutex(true, options.InstanceName, out created, mutexSecurity))
            {
                if (!created)
                {
                    if (!options.Autostart) Signal(options.InstanceName + "-Show");
                    return 0;
                }
                try
                {
                    if (options.Headless) Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
                    using (PlayerContext context = new PlayerContext(options)) Application.Run(context);
                    return 0;
                }
                finally { instance.ReleaseMutex(); }
            }
        }
        private static void Signal(string name)
        {
            for (int i = 0; i < 10; i++)
            {
                try { using (EventWaitHandle signal = EventWaitHandle.OpenExisting(name)) signal.Set(); return; }
                catch (WaitHandleCannotBeOpenedException) { Thread.Sleep(100); }
            }
        }
        private static int StopExisting(Options options)
        {
            try
            {
                using (Mutex instance = Mutex.OpenExisting(options.InstanceName))
                {
                    Signal(options.InstanceName + "-Stop");
                    bool stopped = false;
                    try { stopped = instance.WaitOne(15000); }
                    catch (AbandonedMutexException) { stopped = true; }
                    if (stopped) { instance.ReleaseMutex(); return 0; }
                    return 3;
                }
            }
            catch (WaitHandleCannotBeOpenedException) { return 0; }
        }
        private static int Diagnose(Options options)
        {
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["product"] = "RJ Digital Signage Player";
            result["version"] = "0.3.2";
            result["dataDirectory"] = options.DataDirectory;
            result["contentDirectory"] = options.MediaDirectory;
            result["windows64"] = Environment.Is64BitOperatingSystem;
            result["runtimePresent"] = File.Exists(options.NodePath);
            string runtimeVersion = null;
            if (File.Exists(options.NodePath))
            {
                try
                {
                    ProcessStartInfo info = new ProcessStartInfo(options.NodePath, "-p process.versions.node") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                    using (OwnedProcessJob job = new OwnedProcessJob())
                    using (Process runtime = new Process { StartInfo = info })
                    {
                        runtime.Start(); job.Assign(runtime);
                        if (runtime.WaitForExit(5000) && runtime.ExitCode == 0) runtimeVersion = runtime.StandardOutput.ReadToEnd().Trim();
                    }
                }
                catch { }
            }
            result["runtimeVersion"] = runtimeVersion;
            result["runtime24"] = runtimeVersion != null && runtimeVersion.StartsWith("24.", StringComparison.Ordinal);
            int frameworkRelease = 0;
            try
            {
                using (Microsoft.Win32.RegistryKey registry = Microsoft.Win32.RegistryKey.OpenBaseKey(Microsoft.Win32.RegistryHive.LocalMachine, Microsoft.Win32.RegistryView.Registry64))
                using (Microsoft.Win32.RegistryKey framework = registry.OpenSubKey(@"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full"))
                    if (framework != null) frameworkRelease = Convert.ToInt32(framework.GetValue("Release", 0));
            }
            catch { }
            result["framework48"] = frameworkRelease >= 528040;
            result["agentPresent"] = File.Exists(options.AgentPath);
            result["contentCachePresent"] = File.Exists(Path.Combine(options.InstallDirectory, "player", "content-cache.mjs"));
            result["edgePresent"] = PlayerContext.FindEdge() != null;
            result["rendererPresent"] = File.Exists(Path.Combine(options.InstallDirectory, "public", "player.html"));
            result["youtubePresent"] = File.Exists(Path.Combine(options.InstallDirectory, "shared", "youtube.mjs"));
            result["logoPresent"] = File.Exists(Path.Combine(options.InstallDirectory, "branding", "RJ-Digital-Signage-System-logo-approved-v1.png"));
            bool ok = (bool)result["windows64"] && (bool)result["runtime24"] && (bool)result["framework48"] && (bool)result["agentPresent"] && (bool)result["contentCachePresent"] && (bool)result["rendererPresent"] && (bool)result["youtubePresent"] && (bool)result["logoPresent"] && (bool)result["edgePresent"];
            result["ok"] = ok;
            string json = new JavaScriptSerializer().Serialize(result);
            Console.Out.WriteLine(json);
            if (options.DiagnosticResult != null)
            {
                string parent = Path.GetDirectoryName(options.DiagnosticResult);
                if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);
                File.WriteAllText(options.DiagnosticResult, json, new UTF8Encoding(false));
            }
            return ok ? 0 : 1;
        }
    }

    internal sealed class TimeoutWebClient : WebClient
    {
        protected override WebRequest GetWebRequest(Uri address)
        {
            WebRequest request = base.GetWebRequest(address);
            request.Timeout = 2000;
            HttpWebRequest http = request as HttpWebRequest;
            if (http != null) { http.ReadWriteTimeout = 2000; http.Proxy = null; }
            return request;
        }
    }

    internal sealed class PlayerContext : ApplicationContext
    {
        private readonly Options options;
        private readonly ControlForm form;
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem trayStatus;
        private readonly System.Windows.Forms.Timer timer;
        private readonly EventWaitHandle showSignal, stopSignal;
        private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
        private Process agent;
        private OwnedProcessJob job;
        private bool desiredRun, stopping, exiting, polling, pairing, paired;
        private int restartCount;
        private string ownPlayerId;
        private DateTime restartAt, startedAt, nextStatus;
        private readonly object logLock = new object();

        public PlayerContext(Options options)
        {
            this.options = options;
            Directory.CreateDirectory(options.DataDirectory);
            EventWaitHandleSecurity eventSecurity = new EventWaitHandleSecurity();
            eventSecurity.SetAccessRuleProtection(true, false);
            eventSecurity.AddAccessRule(new EventWaitHandleAccessRule(WindowsIdentity.GetCurrent().User, EventWaitHandleRights.FullControl, AccessControlType.Allow));
            eventSecurity.AddAccessRule(new EventWaitHandleAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), EventWaitHandleRights.FullControl, AccessControlType.Allow));
            bool eventCreated;
            showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, options.InstanceName + "-Show", out eventCreated, eventSecurity);
            stopSignal = new EventWaitHandle(false, EventResetMode.AutoReset, options.InstanceName + "-Stop", out eventCreated, eventSecurity);
            form = new ControlForm(options);
            form.PairRequested += async delegate { await PairAsync(); };
            form.StartRequested += delegate { desiredRun = true; restartCount = 0; StartAgent(true); };
            form.StopRequested += async delegate { desiredRun = false; await StopAgentAsync(); };
            form.RepairRequested += async delegate { await BeginRepairAsync(); };
            form.LogRequested += delegate { OpenLogFolder(); };
            form.ContentRequested += delegate { OpenContentFolder(); };
            form.FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing) { desiredRun = false; return; }
                if (!exiting) { e.Cancel = true; form.Hide(); }
            };
            Icon applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            form.Icon = applicationIcon;
            ContextMenuStrip menu = new ContextMenuStrip();
            trayStatus = new ToolStripMenuItem("RJ Player"); trayStatus.Enabled = false; menu.Items.Add(trayStatus);
            menu.Items.Add("Buka pengaturan", null, delegate { ShowForm(); });
            menu.Items.Add("Mulai tayangan", null, delegate { desiredRun = true; restartCount = 0; StartAgent(true); });
            menu.Items.Add("Hentikan tayangan", null, async delegate { desiredRun = false; await StopAgentAsync(); });
            menu.Items.Add("Buka folder konten", null, delegate { OpenContentFolder(); });
            menu.Items.Add("Buka folder log", null, delegate { OpenLogFolder(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Keluar dari player", null, async delegate
            {
                if (agent != null && MessageBox.Show("Keluar akan menghentikan tayangan pada layar. Lanjutkan?", "RJ Player", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
                await ExitAsync();
            });
            tray = new NotifyIcon { Icon = applicationIcon, Text = "RJ Digital Signage Player", ContextMenuStrip = menu, Visible = !options.Headless };
            tray.DoubleClick += delegate { ShowForm(); };
            LoadPublicConfig();
            timer = new System.Windows.Forms.Timer { Interval = 1000 };
            timer.Tick += Tick;
            timer.Start();
            WriteLog("Aplikasi dibuka.");
            if (!paired || options.Settings) ShowForm();
            if (paired && !options.Settings) { desiredRun = true; StartAgent(false); }
        }

        private void LoadPublicConfig()
        {
            paired = false;
            try
            {
                if (File.Exists(options.ConfigPath))
                {
                    Dictionary<string, object> config = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(options.ConfigPath));
                    paired = config != null && config.ContainsKey("id") && config.ContainsKey("token") && config.ContainsKey("serverUrl") && !String.IsNullOrWhiteSpace(Convert.ToString(config["id"])) && !String.IsNullOrWhiteSpace(Convert.ToString(config["token"])) && !String.IsNullOrWhiteSpace(Convert.ToString(config["serverUrl"]));
                    if (paired) { ownPlayerId = Convert.ToString(config["id"]); form.SetConfiguration(Convert.ToString(config["serverUrl"]), config.ContainsKey("name") ? Convert.ToString(config["name"]) : Environment.MachineName); }
                }
            }
            catch { form.SetMessage("Konfigurasi belum dapat dibaca. Pasangkan kembali player.", true); }
            form.SetPaired(paired);
            SetStatus(paired ? "Siap dijalankan" : "Belum dipasangkan", 0);
        }

        internal static string FindEdge()
        {
            string[] roots = { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) };
            foreach (string root in roots)
            {
                if (String.IsNullOrEmpty(root)) continue;
                string candidate = Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe");
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        private void ShowForm()
        {
            if (exiting || (options.Headless && !options.Settings)) return;
            form.Show(); form.WindowState = FormWindowState.Normal; form.Activate(); form.BringToFront();
        }
        private static string Quote(string value)
        {
            StringBuilder result = new StringBuilder("\""); int slashes = 0;
            foreach (char item in value)
            {
                if (item == '\\') { slashes++; continue; }
                if (item == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(item);
            }
            result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
        }
        private bool PortAvailable()
        {
            TcpListener listener = new TcpListener(IPAddress.Loopback, 3211);
            try { listener.ExclusiveAddressUse = true; listener.Start(); return true; }
            catch (SocketException) { return false; }
            finally { listener.Stop(); }
        }

        private void StartAgent(bool showErrors)
        {
            if (exiting || stopping || pairing || agent != null) return;
            LoadPublicConfig();
            if (!paired) { desiredRun = false; ShowForm(); return; }
            string error = null;
            if (!File.Exists(options.NodePath) || !File.Exists(options.AgentPath)) error = "Berkas aplikasi belum lengkap. Pasang ulang RJ Player menggunakan installer.";
            else if (!options.Headless && FindEdge() == null) error = "Microsoft Edge belum tersedia. Pasang Microsoft Edge pada komputer player terlebih dahulu.";
            else if (!PortAvailable()) error = "Port lokal 3211 sedang dipakai aplikasi lain. Player tidak dijalankan agar tidak mengganggu proses tersebut.";
            if (error != null)
            {
                desiredRun = false; form.SetMessage(error, true); SetStatus("Player belum dapat dijalankan", 0); ShowForm(); return;
            }
            try
            {
                ProcessStartInfo info = new ProcessStartInfo(options.NodePath, Quote(options.AgentPath) + " --supervised --data-dir " + Quote(options.DataDirectory) + " --media-dir " + Quote(options.MediaDirectory) + (options.Headless ? " --headless" : ""));
                info.WorkingDirectory = options.InstallDirectory; info.UseShellExecute = false; info.CreateNoWindow = true;
                info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
                info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
                job = new OwnedProcessJob();
                agent = new Process { StartInfo = info };
                agent.OutputDataReceived += delegate(object sender, DataReceivedEventArgs data) { if (data.Data != null && data.Data.IndexOf("\"event\":\"ready\"", StringComparison.Ordinal) >= 0) WriteLog("Agen siap menerima tayangan."); };
                agent.ErrorDataReceived += delegate { /* Raw output is intentionally not persisted; it may contain remote data. */ };
                agent.Start();
                job.Assign(agent);
                agent.BeginOutputReadLine(); agent.BeginErrorReadLine();
                agent.StandardInput.WriteLine("{\"command\":\"start\"}"); agent.StandardInput.Flush();
                startedAt = DateTime.UtcNow; nextStatus = DateTime.MinValue;
                if (!options.Headless) NativeMethods.SetThreadExecutionState(0x80000003);
                form.SetRunning(true); form.SetMessage("", false); SetStatus("Memulai player…", 0);
                WriteLog("Agen dimulai.");
            }
            catch
            {
                CloseOwnedProcess(); desiredRun = false;
                form.SetMessage("Player belum dapat dijalankan. Periksa folder aplikasi dan izin akun Windows.", true);
                SetStatus("Gagal memulai player", 0); ShowForm();
                WriteLog("Agen gagal dimulai.");
            }
        }

        private async void Tick(object sender, EventArgs args)
        {
            if (exiting) return;
            if (stopSignal.WaitOne(0)) { await ExitAsync(); return; }
            if (showSignal.WaitOne(0)) ShowForm();
            if (!stopping && agent != null && agent.HasExited)
            {
                int code = agent.ExitCode;
                CloseOwnedProcess(); NativeMethods.SetThreadExecutionState(0x80000000);
                form.SetRunning(false);
                WriteLog("Agen berhenti dengan kode " + code.ToString() + ".");
                if (desiredRun)
                {
                    restartCount++;
                    int seconds = Math.Min(60, (int)Math.Pow(2, Math.Min(restartCount, 5)));
                    restartAt = DateTime.UtcNow.AddSeconds(seconds);
                    SetStatus("Memulai ulang dalam " + seconds.ToString() + " detik", 0);
                }
            }
            if (desiredRun && agent == null && !stopping && DateTime.UtcNow >= restartAt) StartAgent(false);
            if (agent == null || stopping || polling || DateTime.UtcNow < nextStatus) return;
            polling = true; nextStatus = DateTime.UtcNow.AddSeconds(3);
            try
            {
                Dictionary<string, object> report = await Task.Run(delegate
                {
                    using (TimeoutWebClient client = new TimeoutWebClient())
                        return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(client.DownloadString("http://127.0.0.1:3211/api/local/status"));
                });
                if (exiting || stopping || agent == null) return;
                if (!report.ContainsKey("application") || Convert.ToString(report["application"]) != "RJDigitalSignagePlayer" || !report.ContainsKey("playerId") || Convert.ToString(report["playerId"]) != ownPlayerId)
                    throw new InvalidOperationException("Status bukan milik player ini.");
                string state = report.ContainsKey("status") ? Convert.ToString(report["status"]) : "standby";
                bool connected = report.ContainsKey("connected") && Convert.ToBoolean(report["connected"]);
                int progress = report.ContainsKey("progress") ? Math.Max(0, Math.Min(100, Convert.ToInt32(report["progress"]))) : 0;
                Dictionary<string, string> labels = new Dictionary<string, string> { { "playing", "Tayangan aktif" }, { "waiting-video", "Menunggu video selesai" }, { "downloading", "Mengunduh media" }, { "ready", "Konten siap" }, { "cached", "Cache tersedia" }, { "standby", "Menunggu tayangan" }, { "error", "Sinkronisasi tertunda" } };
                SetStatus((labels.ContainsKey(state) ? labels[state] : "Player berjalan") + (connected ? " · CMS tersambung" : " · CMS offline"), progress);
                if (report.ContainsKey("lastError") && !String.IsNullOrWhiteSpace(Convert.ToString(report["lastError"]))) form.SetMessage(Convert.ToString(report["lastError"]), true);
                else form.SetMessage("", false);
                if ((DateTime.UtcNow - startedAt).TotalSeconds >= 30) restartCount = 0;
            }
            catch { if (!stopping && agent != null) SetStatus("Menyiapkan pemutar lokal…", 0); }
            finally { polling = false; }
        }

        private async Task StopAgentAsync()
        {
            if (stopping) return;
            stopping = true;
            NativeMethods.SetThreadExecutionState(0x80000000);
            Process current = agent;
            try
            {
                if (current != null && !current.HasExited)
                {
                    try { current.StandardInput.WriteLine("{\"command\":\"shutdown\"}"); current.StandardInput.Flush(); current.StandardInput.Close(); }
                    catch (InvalidOperationException) { }
                    catch (IOException) { }
                    await Task.Run(delegate { try { current.WaitForExit(6000); } catch (InvalidOperationException) { } });
                }
            }
            finally
            {
                CloseOwnedProcess(); stopping = false; form.SetRunning(false); SetStatus(paired ? "Player dihentikan" : "Belum dipasangkan", 0); WriteLog("Tayangan dihentikan.");
            }
        }

        private void CloseOwnedProcess()
        {
            if (job != null) { job.Dispose(); job = null; }
            if (agent != null)
            {
                try { if (!agent.HasExited) agent.Kill(); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
                agent.Dispose(); agent = null;
            }
        }

        private async Task BeginRepairAsync()
        {
            if (pairing || stopping) return;
            if (MessageBox.Show("Pasangkan ulang ke CMS? Tayangan akan dihentikan. Konfigurasi lama baru diganti setelah pemasangan baru berhasil.", "Pasangkan ulang RJ Player", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            desiredRun = false; await StopAgentAsync(); form.EnablePairing(true);
            form.SetMessage("Ambil kode baru dari menu Player di CMS, lalu isi alamat server dan nama player.", false);
        }

        private async Task PairAsync()
        {
            if (pairing || stopping || exiting) return;
            if (agent != null) { form.SetMessage("Hentikan tayangan sebelum memasangkan ulang player.", true); return; }
            Uri url;
            if (!Uri.TryCreate(form.ServerUrl.Trim(), UriKind.Absolute, out url) || (url.Scheme != "http" && url.Scheme != "https") || !String.IsNullOrEmpty(url.UserInfo))
            { form.SetMessage("Isi alamat CMS HTTP/HTTPS tanpa nama pengguna atau password di alamat.", true); return; }
            string code = form.PairCode.Trim();
            if (code.Length != 6 || !System.Text.RegularExpressions.Regex.IsMatch(code, "^[0-9]{6}$")) { form.SetMessage("Kode pemasangan harus berisi enam digit dari menu Player di CMS.", true); return; }
            string name = form.PlayerName.Trim();
            if (name.Length == 0 || name.Length > 120) { form.SetMessage("Nama player harus diisi, maksimal 120 karakter.", true); return; }
            if (!File.Exists(options.NodePath) || !File.Exists(options.AgentPath)) { form.SetMessage("Berkas aplikasi belum lengkap. Pasang ulang RJ Player.", true); return; }
            pairing = true; form.SetBusy(true); form.SetMessage("Menghubungkan player ke CMS…", false);
            try
            {
                Dictionary<string, object> input = new Dictionary<string, object> { { "serverUrl", url.GetLeftPart(UriPartial.Authority) }, { "code", code }, { "name", name } };
                string inputJson = serializer.Serialize(input);
                bool replace = paired;
                Dictionary<string, object> result = await Task.Run(delegate { return PairHelper(inputJson, replace); });
                if (!result.ContainsKey("ok") || !Convert.ToBoolean(result["ok"])) throw new InvalidOperationException(result.ContainsKey("error") ? Convert.ToString(result["error"]) : "Pemasangan belum berhasil.");
                form.ClearCode(); LoadPublicConfig(); form.SetMessage("Player berhasil dipasangkan.", false); WriteLog("Pemasangan player berhasil.");
                desiredRun = true;
            }
            catch (Exception error)
            {
                // Restore the usable previous configuration and its Start button on repair failure.
                LoadPublicConfig();
                form.SetMessage(error is InvalidOperationException ? error.Message : "CMS belum dapat dihubungi. Periksa alamat server, jaringan, dan kode pemasangan.", true);
            }
            finally { pairing = false; form.SetBusy(false); }
            if (desiredRun && paired) { StartAgent(true); if (agent != null) form.Hide(); }
        }

        private Dictionary<string, object> PairHelper(string inputJson, bool replace)
        {
            ProcessStartInfo info = new ProcessStartInfo(options.NodePath, Quote(options.AgentPath) + " pair --json --data-dir " + Quote(options.DataDirectory) + (replace ? " --replace" : ""));
            info.WorkingDirectory = options.InstallDirectory; info.UseShellExecute = false; info.CreateNoWindow = true;
            info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
            using (OwnedProcessJob pairJob = new OwnedProcessJob())
            using (Process process = new Process { StartInfo = info })
            {
                process.Start(); pairJob.Assign(process);
                Task<string> output = process.StandardOutput.ReadToEndAsync();
                Task<string> errors = process.StandardError.ReadToEndAsync();
                byte[] inputBytes = Encoding.UTF8.GetBytes(inputJson + "\n");
                process.StandardInput.BaseStream.Write(inputBytes, 0, inputBytes.Length); process.StandardInput.BaseStream.Flush(); process.StandardInput.Close();
                if (!process.WaitForExit(45000)) throw new InvalidOperationException("CMS belum merespons. Periksa jaringan dan coba lagi.");
                Task.WaitAll(output, errors);
                string response = process.ExitCode == 0 ? output.Result : errors.Result;
                Dictionary<string, object> result;
                try { result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(response.Trim()); }
                catch { throw new InvalidOperationException("Pemasangan belum berhasil. Periksa alamat server dan kode pemasangan."); }
                if (result == null) throw new InvalidOperationException("Pemasangan belum berhasil.");
                return result;
            }
        }

        private void SetStatus(string text, int progress)
        {
            form.SetStatus(text, progress); trayStatus.Text = text;
            tray.Text = ("RJ Player · " + text).Length <= 63 ? "RJ Player · " + text : "RJ Player";
        }
        private void OpenLogFolder()
        {
            string directory = Path.Combine(options.DataDirectory, "logs");
            Directory.CreateDirectory(directory);
            Process.Start(new ProcessStartInfo("explorer.exe", Quote(directory)) { UseShellExecute = true });
        }
        private void OpenContentFolder()
        {
            try
            {
                Directory.CreateDirectory(options.MediaDirectory);
                Process.Start(new ProcessStartInfo("explorer.exe", Quote(options.MediaDirectory)) { UseShellExecute = true });
            }
            catch
            {
                form.SetMessage("Folder konten belum dapat dibuka. Periksa lokasi dan izin folder.", true);
                ShowForm();
            }
        }
        private void WriteLog(string message)
        {
            try
            {
                lock (logLock)
                {
                    string directory = Path.Combine(options.DataDirectory, "logs"); Directory.CreateDirectory(directory);
                    string filename = Path.Combine(directory, "player-desktop.log");
                    if (File.Exists(filename) && new FileInfo(filename).Length > 1024 * 1024)
                    {
                        string previous = Path.Combine(directory, "player-desktop.previous.log");
                        if (File.Exists(previous)) File.Delete(previous);
                        File.Move(filename, previous);
                    }
                    File.AppendAllText(filename, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message.Replace("\r", " ").Replace("\n", " ") + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { /* Logging must not interrupt playback. */ }
        }
        private async Task ExitAsync()
        {
            if (exiting) return;
            exiting = true; desiredRun = false; timer.Stop();
            await StopAgentAsync(); tray.Visible = false; form.Close(); ExitThread();
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                desiredRun = false; CloseOwnedProcess(); NativeMethods.SetThreadExecutionState(0x80000000);
                timer.Dispose(); tray.Visible = false; tray.Dispose(); showSignal.Dispose(); stopSignal.Dispose(); form.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class ControlForm : Form
    {
        internal event EventHandler PairRequested, StartRequested, StopRequested, RepairRequested, LogRequested, ContentRequested;
        private TextBox server, name, code;
        private Label status, message;
        private ProgressBar progress;
        private Button pair, start, stop, repair;
        private readonly ToolTip contentHint = new ToolTip();
        private bool paired, running, busy, pairingEnabled;
        private static readonly Color Navy = Color.FromArgb(17, 36, 66);
        private static readonly Color Teal = Color.FromArgb(0, 143, 131);
        public string ServerUrl { get { return server.Text; } }
        public string PlayerName { get { return name.Text; } }
        public string PairCode { get { return code.Text; } }

        public ControlForm(Options options)
        {
            Text = "RJ Digital Signage Player"; ClientSize = new Size(600, 656); MinimumSize = new Size(540, 520); MaximumSize = new Size(900, 900); AutoScroll = true;
            StartPosition = FormStartPosition.CenterScreen; Font = new Font("Segoe UI", 10); BackColor = Color.FromArgb(246, 248, 251); ForeColor = Navy;
            AutoScaleDimensions = new SizeF(96, 96); AutoScaleMode = AutoScaleMode.Dpi;
            Panel header = new Panel { Dock = DockStyle.Top, Height = 108, BackColor = Navy };
            PictureBox logo = new PictureBox { Location = new Point(24, 17), Size = new Size(75, 75), SizeMode = PictureBoxSizeMode.Zoom };
            string logoPath = Path.Combine(options.InstallDirectory, "branding", "RJ-Digital-Signage-System-logo-approved-v1.png");
            if (File.Exists(logoPath)) { using (Image original = Image.FromFile(logoPath)) logo.Image = new Bitmap(original); }
            header.Controls.Add(logo);
            header.Controls.Add(new Label { Text = "RJ DIGITAL SIGNAGE", ForeColor = Color.White, Font = new Font("Segoe UI", 18, FontStyle.Bold), Location = new Point(116, 23), AutoSize = true });
            header.Controls.Add(new Label { Text = "PLAYER WINDOWS", ForeColor = Color.FromArgb(119, 217, 204), Location = new Point(119, 62), AutoSize = true, Font = new Font("Segoe UI", 10) });
            Controls.Add(header);
            Label description = new Label { Text = "Hubungkan komputer ini ke CMS untuk menerima dan memutar tayangan.", Location = new Point(26, 125), Size = new Size(548, 42) }; Controls.Add(description);
            Panel statusPanel = new Panel { Location = new Point(26, 174), Size = new Size(548, 72), BackColor = Color.White, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
            status = new Label { Text = "Belum dipasangkan", Location = new Point(14, 12), AutoEllipsis = true, Size = new Size(519, 24), Font = new Font("Segoe UI", 10, FontStyle.Bold) }; statusPanel.Controls.Add(status);
            progress = new ProgressBar { Location = new Point(14, 44), Size = new Size(519, 8), Style = ProgressBarStyle.Continuous }; statusPanel.Controls.Add(progress); Controls.Add(statusPanel);
            AddLabel("Alamat CMS", 263); server = AddTextBox("http://IP-SERVER", 286);
            AddLabel("Nama player", 328); name = AddTextBox(Environment.MachineName, 351); name.MaxLength = 120;
            AddLabel("Kode pemasangan enam digit", 393); code = AddTextBox("", 416); code.MaxLength = 6;
            code.KeyPress += delegate(object sender, KeyPressEventArgs e) { if (!Char.IsControl(e.KeyChar) && !Char.IsDigit(e.KeyChar)) e.Handled = true; };
            Label help = new Label { Text = "Ambil kode dari menu Player → Pasangkan player di CMS.", Location = new Point(26, 450), Size = new Size(548, 23), ForeColor = Color.FromArgb(90, 105, 125), Font = new Font("Segoe UI", 9) }; Controls.Add(help);
            pair = AddButton("Hubungkan & mulai", 26, 482, 548, Teal, Color.White); pair.Click += delegate { Raise(PairRequested); };
            start = AddButton("Mulai tayangan", 26, 482, 266, Teal, Color.White); start.Click += delegate { Raise(StartRequested); };
            stop = AddButton("Hentikan tayangan", 307, 482, 267, Color.White, Navy); stop.Click += delegate { Raise(StopRequested); };
            repair = AddButton("Pasangkan ulang", 26, 532, 130, Color.White, Navy); repair.Click += delegate { Raise(RepairRequested); };
            Button contents = AddButton("Folder konten", 166, 532, 130, Color.White, Navy); contents.Click += delegate { Raise(ContentRequested); };
            Button logs = AddButton("Folder log", 306, 532, 130, Color.White, Navy); logs.Click += delegate { Raise(LogRequested); };
            Button hide = AddButton("Simpan di tray", 446, 532, 128, Color.White, Navy); hide.Click += delegate { Hide(); };
            Label contentPath = new Label { Text = "Konten: " + options.MediaDirectory, Location = new Point(26, 575), Size = new Size(548, 20), ForeColor = Color.FromArgb(90, 105, 125), Font = new Font("Segoe UI", 8), AutoEllipsis = true, Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right }; Controls.Add(contentPath);
            contentHint.SetToolTip(contents, options.MediaDirectory); contentHint.SetToolTip(contentPath, options.MediaDirectory);
            message = new Label { Text = "", Location = new Point(26, 599), Size = new Size(548, 28), Font = new Font("Segoe UI", 9), AutoEllipsis = true }; Controls.Add(message);
            Controls.Add(new Label { Text = "Copyright ©2026 Rino Joe", Location = new Point(26, 629), Size = new Size(548, 18), ForeColor = Color.FromArgb(105, 117, 132), Font = new Font("Segoe UI", 7.5f) });
            Shown += delegate { Rectangle area = Screen.FromControl(this).WorkingArea; Size = new Size(Math.Min(Width, area.Width - 32), Math.Min(Height, area.Height - 32)); };
            UpdateControls();
        }
        private void Raise(EventHandler handler) { if (handler != null) handler(this, EventArgs.Empty); }
        private void AddLabel(string text, int y) { Controls.Add(new Label { Text = text, Location = new Point(26, y), AutoSize = true, Font = new Font("Segoe UI", 9, FontStyle.Bold) }); }
        private TextBox AddTextBox(string text, int y)
        {
            TextBox input = new TextBox { Text = text, Location = new Point(26, y), Size = new Size(548, 30), BorderStyle = BorderStyle.FixedSingle, Font = new Font("Segoe UI", 11), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
            Controls.Add(input); return input;
        }
        private Button AddButton(string text, int x, int y, int width, Color background, Color foreground)
        {
            Button button = new Button { Text = text, Location = new Point(x, y), Size = new Size(width, 38), BackColor = background, ForeColor = foreground, FlatStyle = FlatStyle.Flat, Cursor = Cursors.Hand, Font = new Font("Segoe UI", 9, FontStyle.Bold) };
            button.FlatAppearance.BorderColor = background == Color.White ? Color.FromArgb(214, 222, 232) : background;
            Controls.Add(button); return button;
        }
        public void SetConfiguration(string serverUrl, string playerName) { server.Text = serverUrl; name.Text = playerName; }
        public void SetPaired(bool value) { paired = value; pairingEnabled = !value; UpdateControls(); }
        public void SetRunning(bool value) { running = value; UpdateControls(); }
        public void SetBusy(bool value) { busy = value; UpdateControls(); }
        public void EnablePairing(bool value) { pairingEnabled = value; UpdateControls(); code.Focus(); }
        public void ClearCode() { code.Text = ""; }
        public void SetStatus(string text, int percentage) { status.Text = text; progress.Value = Math.Max(0, Math.Min(100, percentage)); }
        public void SetMessage(string text, bool error) { message.Text = text; message.ForeColor = error ? Color.FromArgb(165, 50, 50) : Color.FromArgb(71, 92, 113); }
        private void UpdateControls()
        {
            server.ReadOnly = busy || !pairingEnabled; name.ReadOnly = busy || !pairingEnabled; code.ReadOnly = busy || !pairingEnabled;
            pair.Visible = pairingEnabled; pair.Enabled = !busy; start.Visible = stop.Visible = !pairingEnabled;
            start.Enabled = paired && !running && !busy; stop.Enabled = running && !busy; repair.Enabled = paired && !busy; repair.Visible = paired;
            pair.Text = busy ? "Menghubungkan…" : "Hubungkan & mulai";
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                contentHint.Dispose();
                foreach (Control control in Controls) { Panel panel = control as Panel; if (panel != null) foreach (Control child in panel.Controls) { PictureBox picture = child as PictureBox; if (picture != null && picture.Image != null) { picture.Image.Dispose(); picture.Image = null; } } }
            }
            base.Dispose(disposing);
        }
    }

    internal sealed class OwnedProcessJob : IDisposable
    {
        private IntPtr handle;
        public OwnedProcessJob()
        {
            handle = NativeMethods.CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION information = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            information.BasicLimitInformation.LimitFlags = 0x00002000;
            int length = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr pointer = Marshal.AllocHGlobal(length);
            try
            {
                Marshal.StructureToPtr(information, pointer, false);
                if (!NativeMethods.SetInformationJobObject(handle, 9, pointer, (uint)length)) throw new System.ComponentModel.Win32Exception();
            }
            catch { Dispose(); throw; }
            finally { Marshal.FreeHGlobal(pointer); }
        }
        public void Assign(Process process) { if (!NativeMethods.AssignProcessToJobObject(handle, process.Handle)) { try { process.Kill(); } catch { } throw new System.ComponentModel.Win32Exception(); } }
        public void Dispose() { if (handle != IntPtr.Zero) { NativeMethods.CloseHandle(handle); handle = IntPtr.Zero; } }
    }

    internal static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION { internal long PerProcessUserTimeLimit, PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; internal IO_COUNTERS IoInfo; internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] internal static extern uint SetThreadExecutionState(uint flags);
    }
}
