using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace Fardel.Editor
{
    /// <summary>
    /// Visual evidence: Play Connect, wait for Connected, screenshot Game view.
    /// Survives play-mode domain reload via SessionState + InitializeOnLoad.
    /// Unity … -executeMethod Fardel.Editor.FardelVeCapture.Run
    /// </summary>
    [InitializeOnLoad]
    public static class FardelVeCapture
    {
        const string ActiveKey = "Fardel.VE.Active";
        const string DeadlineKey = "Fardel.VE.Deadline";
        const string CaptureQueuedKey = "Fardel.VE.CaptureQueued";
        const double TimeoutSec = 60;

        static FardelVeCapture()
        {
            EditorApplication.playModeStateChanged += OnPlayMode;
            if (SessionState.GetBool(ActiveKey, false))
            {
                EditorApplication.update += Tick;
            }
        }

        public static void Run()
        {
            var veDir = VeDir();
            Directory.CreateDirectory(veDir);
            foreach (var name in new[] { "connect-ready.txt", "connect-done.txt", "connect-fail.txt", "connect-hud.png" })
            {
                var p = Path.Combine(veDir, name);
                if (File.Exists(p)) File.Delete(p);
            }

            if (!File.Exists(FardelBootstrap.ConnectScenePath))
            {
                Fail($"missing scene {FardelBootstrap.ConnectScenePath}");
                return;
            }

            EditorSceneManager.OpenScene(FardelBootstrap.ConnectScenePath);
            EditorApplication.ExecuteMenuItem("Window/General/Game");

            SessionState.SetBool(ActiveKey, true);
            SessionState.SetBool(CaptureQueuedKey, false);
            SessionState.SetFloat(DeadlineKey, (float)(EditorApplication.timeSinceStartup + TimeoutSec));
            EditorApplication.update -= Tick;
            EditorApplication.update += Tick;
            EditorApplication.isPlaying = true;
            Debug.Log("[Fardel VE] Entered play; waiting for Connected…");
        }

        static void OnPlayMode(PlayModeStateChange state)
        {
            if (!SessionState.GetBool(ActiveKey, false))
            {
                return;
            }

            if (state == PlayModeStateChange.EnteredPlayMode)
            {
                // Re-arm after domain reload
                SessionState.SetFloat(DeadlineKey, (float)(EditorApplication.timeSinceStartup + TimeoutSec));
                EditorApplication.update -= Tick;
                EditorApplication.update += Tick;
                Debug.Log("[Fardel VE] Play mode entered; tick armed");
            }
        }

        static void Tick()
        {
            if (!SessionState.GetBool(ActiveKey, false))
            {
                return;
            }

            if (SessionState.GetBool(CaptureQueuedKey, false))
            {
                return;
            }

            var deadline = SessionState.GetFloat(DeadlineKey, 0f);
            if (EditorApplication.timeSinceStartup > deadline)
            {
                Fail("timeout waiting for Connected");
                return;
            }

            var conn = UnityEngine.Object.FindAnyObjectByType<Fardel.FardelConnection>();
            var status = conn != null ? conn.Status : "";
            var readyPath = Path.Combine(VeDir(), "connect-ready.txt");
            var connected = status == "Connected" || File.Exists(readyPath);
            if (!connected)
            {
                // Surface errors in VE log without stopping early (allow retries)
                if (!string.IsNullOrEmpty(status) && status.StartsWith("Error", StringComparison.Ordinal))
                {
                    // keep waiting until timeout — connection may retry
                }
                return;
            }

            SessionState.SetBool(CaptureQueuedKey, true);
            EditorApplication.delayCall += () =>
            {
                var png = Path.Combine(VeDir(), "connect-hud.png");
                try
                {
                    // Relative path is more reliable for Editor Game view capture
                    var rel = "ve-connect-hud.png";
                    ScreenCapture.CaptureScreenshot(rel);
                    Debug.Log($"[Fardel VE] CaptureScreenshot => {rel}");
                    EditorApplication.delayCall += () => WaitForPng(rel, png);
                }
                catch (Exception e)
                {
                    Fail(e.ToString());
                }
            };
        }

        static void WaitForPng(string relName, string destAbs)
        {
            var projectRel = Path.GetFullPath(Path.Combine(Application.dataPath, "..", relName));
            var deadline = SessionState.GetFloat(DeadlineKey, 0f) + 15f;
            if (File.Exists(projectRel) && new FileInfo(projectRel).Length > 0)
            {
                Directory.CreateDirectory(VeDir());
                File.Copy(projectRel, destAbs, overwrite: true);
                FinishOk(destAbs);
                return;
            }

            if (EditorApplication.timeSinceStartup > deadline)
            {
                // Fallback: capture editor window via internal API if screenshot missing
                Fail($"screenshot file not written ({projectRel})");
                return;
            }

            EditorApplication.delayCall += () => WaitForPng(relName, destAbs);
        }

        static void FinishOk(string pngPath)
        {
            Cleanup();
            var ready = Path.Combine(VeDir(), "connect-ready.txt");
            var id = File.Exists(ready) ? File.ReadAllText(ready).Trim() : "";
            File.WriteAllText(Path.Combine(VeDir(), "connect-done.txt"), $"ok\n{pngPath}\n{id}\n");
            Debug.Log($"[Fardel VE] DONE {pngPath}");
            EditorApplication.isPlaying = false;
            EditorApplication.delayCall += () => EditorApplication.Exit(0);
        }

        static void Fail(string msg)
        {
            Cleanup();
            try
            {
                Directory.CreateDirectory(VeDir());
                File.WriteAllText(Path.Combine(VeDir(), "connect-fail.txt"), msg);
            }
            catch { /* ignore */ }
            Debug.LogError($"[Fardel VE] FAIL: {msg}");
            EditorApplication.isPlaying = false;
            EditorApplication.delayCall += () => EditorApplication.Exit(1);
        }

        static void Cleanup()
        {
            SessionState.SetBool(ActiveKey, false);
            SessionState.SetBool(CaptureQueuedKey, false);
            EditorApplication.update -= Tick;
        }

        static string VeDir() => Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "ve"));
    }
}
