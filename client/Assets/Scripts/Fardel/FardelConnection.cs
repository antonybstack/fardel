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

        void Awake()
        {
            if (GetComponent<SpacetimeDBNetworkManager>() == null)
            {
                gameObject.AddComponent<SpacetimeDBNetworkManager>();
            }
        }

        void Start() => Connect();

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
        }

        void OnConnectError(System.Exception e)
        {
            _status = $"Error: {e.Message}";
            Debug.LogError($"[Fardel] Connect error: {e}");
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
