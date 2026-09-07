using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Fardel;

namespace Fardel.Editor
{
    public static class FardelBootstrap
    {
        public const string ConnectScenePath = "Assets/Scenes/Connect.unity";

        [MenuItem("Fardel/Setup Connect Scene")]
        public static void SetupConnectScene()
        {
            if (!AssetDatabase.IsValidFolder("Assets/Scenes"))
            {
                AssetDatabase.CreateFolder("Assets", "Scenes");
            }

            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            var go = new GameObject("FardelConnection");
            go.AddComponent<FardelConnection>();

            EditorSceneManager.SaveScene(scene, ConnectScenePath);
            var scenes = new[] { new EditorBuildSettingsScene(ConnectScenePath, true) };
            EditorBuildSettings.scenes = scenes;
            Debug.Log($"[Fardel] Wrote {ConnectScenePath} and set as build scene 0.");
        }

        // Batchmode entry: Unity -batchmode -quit -projectPath ... -executeMethod Fardel.Editor.FardelBootstrap.SetupConnectSceneBatch
        public static void SetupConnectSceneBatch()
        {
            SetupConnectScene();
        }
    }
}
