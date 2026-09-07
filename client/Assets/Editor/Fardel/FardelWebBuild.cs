using System.IO;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace Fardel.Editor
{
    /// <summary>
    /// Batch: Unity -batchmode -quit -projectPath client -executeMethod Fardel.Editor.FardelWebBuild.BuildWebGL
    /// Output: Builds/WebGL/
    /// </summary>
    public static class FardelWebBuild
    {
        public const string OutputDir = "Builds/WebGL";

        public static void BuildWebGL()
        {
            if (!File.Exists(FardelBootstrap.ConnectScenePath))
            {
                Debug.LogError($"[Fardel Web] missing {FardelBootstrap.ConnectScenePath}");
                EditorApplication.Exit(1);
                return;
            }

            var scenes = new[] { FardelBootstrap.ConnectScenePath };
            var absOut = Path.GetFullPath(Path.Combine(Application.dataPath, "..", OutputDir));
            if (Directory.Exists(absOut))
            {
                Directory.Delete(absOut, recursive: true);
            }

            Directory.CreateDirectory(absOut);

            PlayerSettings.WebGL.memorySize = 512;
            PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.FullWithoutStacktrace;
            // Gzip: keep wasm under Cloudflare Pages 25 MiB/file limit.
            // Pages strips Content-Encoding from _headers, so enable decompressionFallback
            // and serve .gz without Content-Encoding (Unity gunzips client-side).
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Gzip;
            PlayerSettings.WebGL.decompressionFallback = true;

            var opts = new BuildPlayerOptions
            {
                scenes = scenes,
                locationPathName = absOut,
                target = BuildTarget.WebGL,
                options = BuildOptions.None,
            };

            Debug.Log($"[Fardel Web] Building WebGL → {absOut}");
            var report = BuildPipeline.BuildPlayer(opts);
            var summary = report.summary;
            Debug.Log($"[Fardel Web] result={summary.result} errors={summary.totalErrors} size={summary.totalSize}");
            if (summary.result != BuildResult.Succeeded)
            {
                EditorApplication.Exit(1);
                return;
            }

            // MIME only — do not set Content-Encoding (Pages strips it; Unity fallback ungzip's).
            File.WriteAllText(Path.Combine(absOut, "_headers"),
@"/Build/*.wasm.unityweb
  Content-Type: application/wasm

/Build/*.data.unityweb
  Content-Type: application/octet-stream

/Build/*.js.unityweb
  Content-Type: application/javascript

/Build/*.unityweb
  Content-Type: application/octet-stream
");

            var ve = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "ve"));
            Directory.CreateDirectory(ve);
            File.WriteAllText(Path.Combine(ve, "webgl-build-done.txt"), absOut + "\n");
            EditorApplication.Exit(0);
        }
    }
}
