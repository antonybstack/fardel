using SpacetimeDB;
using SpacetimeDB.Types;
using UnityEngine;

namespace Fardel
{
    /// <summary>
    /// Slice 0: connect to local SpacetimeDB and show identity.
    /// Requires SpacetimeDBNetworkManager (added automatically) so FrameTick runs every Update.
    /// </summary>
    public sealed class FardelConnection : MonoBehaviour
    {
        [SerializeField] string uri = "http://127.0.0.1:3000";
        [SerializeField] string databaseName = "fardel";

        DbConnection? _conn;
        string _status = "Connecting…";
        string _identity = "";
        int _retries;

        public string Status => _status;
        public string IdentityText => _identity;

        void Awake()
        {
            if (GetComponent<SpacetimeDBNetworkManager>() == null)
            {
                gameObject.AddComponent<SpacetimeDBNetworkManager>();
            }

            ResolveEndpoint();
        }

        void Start() => Connect();

        void ResolveEndpoint()
        {
            var pageUrl = Application.absoluteURL ?? "";
            var servedFromLocal =
                pageUrl.Contains("127.0.0.1", System.StringComparison.OrdinalIgnoreCase)
                || pageUrl.Contains("localhost", System.StringComparison.OrdinalIgnoreCase);

            // Player builds on a real host default to the preview tunnel.
            // Localhost WebGL must keep 127.0.0.1 (do not rewrite before ?db=).
            if (!Application.isEditor && !servedFromLocal && uri.Contains("127.0.0.1"))
            {
                uri = "https://dev-db.sparkify.dev";
            }

            // ?db= / ?database= always win (local serve / Pages debug)
            if (string.IsNullOrEmpty(pageUrl))
            {
                return;
            }

            var qIdx = pageUrl.IndexOf('?');
            if (qIdx < 0)
            {
                return;
            }

            foreach (var part in pageUrl[(qIdx + 1)..].Split('&'))
            {
                var kv = part.Split('=', 2);
                if (kv.Length != 2)
                {
                    continue;
                }

                if (kv[0] == "db")
                {
                    uri = UnityEngine.Networking.UnityWebRequest.UnEscapeURL(kv[1]);
                }
                else if (kv[0] == "database")
                {
                    databaseName = UnityEngine.Networking.UnityWebRequest.UnEscapeURL(kv[1]);
                }
            }
        }

        void Connect()
        {
            _status = "Connecting…";
            _conn = DbConnection.Builder()
                .WithUri(uri)
                .WithDatabaseName(databaseName)
                .OnConnect(OnConnected)
                .OnConnectError(OnConnectError)
                .OnDisconnect(OnDisconnected)
                .Build();
        }

        void OnConnected(DbConnection conn, Identity identity, string token)
        {
            _status = "Connected";
            _identity = identity.ToString();
            Debug.Log($"[Fardel] Connected as {_identity}");
            try
            {
                var dir = System.IO.Path.GetFullPath(System.IO.Path.Combine(Application.dataPath, "..", "..", "ve"));
                System.IO.Directory.CreateDirectory(dir);
                System.IO.File.WriteAllText(System.IO.Path.Combine(dir, "connect-ready.txt"), _identity);
            }
            catch (System.Exception ex)
            {
                Debug.LogWarning($"[Fardel] VE marker write failed: {ex.Message}");
            }
        }

        void OnConnectError(System.Exception e)
        {
            _status = $"Error: {e.Message}";
            Debug.LogError($"[Fardel] Connect error: {e}");
            if (_retries < 8)
            {
                _retries++;
                _status = $"Retrying… ({_retries})";
                Invoke(nameof(Connect), 1.5f);
            }
        }

        void OnDisconnected(DbConnection conn, System.Exception? e)
        {
            _status = e == null ? "Disconnected" : $"Disconnected: {e.Message}";
            Debug.LogWarning($"[Fardel] {_status}");
        }

        void OnGUI()
        {
            const int pad = 12;
            var style = new GUIStyle(GUI.skin.label) { fontSize = 16 };
            GUI.Label(new Rect(pad, pad, Screen.width - pad * 2, 28), $"Fardel — {_status}", style);
            if (!string.IsNullOrEmpty(_identity))
            {
                GUI.Label(new Rect(pad, pad + 32, Screen.width - pad * 2, 28), $"Identity: {_identity}", style);
            }
            GUI.Label(new Rect(pad, pad + 64, Screen.width - pad * 2, 28), $"DB: {databaseName} @ {uri}", style);
        }
    }
}
