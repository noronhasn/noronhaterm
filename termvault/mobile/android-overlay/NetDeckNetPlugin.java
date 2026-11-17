package com.netdeck.app;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UIKeyboardInteractive;
import com.jcraft.jsch.UserInfo;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Ponte nativa do NetDeck: SSH (JSch, com os algoritmos antigos dos switches e roteadores) e socket TCP
 * (usado pelo cliente Telnet, que é o mesmo código JavaScript do computador).
 * Tudo que vai para a interface sai por eventos: data, closed, status, hostkey, tcpdata, tcpclosed.
 */
@CapacitorPlugin(name = "NetDeckNet")
public class NetDeckNetPlugin extends Plugin {

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Map<String, SshConn> sshConns = new ConcurrentHashMap<>();
    private final Map<String, TcpConn> tcpConns = new ConcurrentHashMap<>();
    private final Map<String, CompletableFuture<Boolean>> keyAnswers = new ConcurrentHashMap<>();

    // ------------------------------------------------------------------ eventos

    private void emit(String event, JSObject data) {
        notifyListeners(event, data);
    }

    private void status(String sid, String msg) {
        JSObject o = new JSObject();
        o.put("sid", sid);
        o.put("msg", msg);
        emit("status", o);
    }

    private static String b64(byte[] b, int len) {
        return Base64.encodeToString(Arrays.copyOf(b, len), Base64.NO_WRAP);
    }

    private static String explain(Throwable t) {
        String m = t.getMessage() == null ? t.toString() : t.getMessage();
        if (m.contains("Auth fail") || m.contains("Auth cancel")) {
            return "Usuário ou senha incorretos (" + m + ")";
        }
        if (m.contains("Algorithm negotiation fail")) {
            return m + ". O equipamento exige um algoritmo que o app não suporta.";
        }
        if (m.contains("reject HostKey") || m.contains("HostKey has been changed")) {
            return "Conexão cancelada: a chave do servidor não foi aceita";
        }
        if (m.contains("timeout") || m.contains("timed out")) {
            return "Tempo esgotado ao conectar (" + m + ")";
        }
        if (t instanceof java.net.UnknownHostException) {
            return "Endereço não encontrado: " + m;
        }
        return m;
    }

    // ------------------------------------------------------------------ SSH

    @PluginMethod
    public void sshOpen(final PluginCall call) {
        final String sid = call.getString("sid");
        final JSArray hops = call.getArray("hops");
        final JSArray forwards = call.getArray("forwards");
        final int cols = call.getInt("cols", 80);
        final int rows = call.getInt("rows", 24);
        if (sid == null || hops == null || hops.length() == 0) {
            call.reject("Parâmetros inválidos");
            return;
        }
        pool.execute(new Runnable() {
            @Override
            public void run() {
                SshConn c = new SshConn(sid);
                sshConns.put(sid, c);
                try {
                    c.open(hops, forwards, cols, rows);
                    call.resolve();
                } catch (Throwable t) {
                    c.close(null);
                    sshConns.remove(sid);
                    call.reject(explain(t));
                }
            }
        });
    }

    @PluginMethod
    public void sshWrite(final PluginCall call) {
        SshConn c = sshConns.get(call.getString("sid"));
        String data = call.getString("data");
        if (c != null && data != null) {
            c.write(data.getBytes(StandardCharsets.UTF_8));
        }
        call.resolve();
    }

    @PluginMethod
    public void sshResize(PluginCall call) {
        SshConn c = sshConns.get(call.getString("sid"));
        if (c != null) {
            c.resize(call.getInt("cols", 80), call.getInt("rows", 24));
        }
        call.resolve();
    }

    @PluginMethod
    public void sshClose(PluginCall call) {
        String sid = call.getString("sid");
        SshConn c = sshConns.remove(sid);
        if (c != null) {
            c.close(null);
        }
        call.resolve();
    }

    @PluginMethod
    public void hostKeyAnswer(PluginCall call) {
        CompletableFuture<Boolean> f = keyAnswers.get(call.getString("sid") + ":" + call.getInt("hop", 0));
        if (f != null) {
            f.complete(Boolean.TRUE.equals(call.getBoolean("ok", false)));
        }
        call.resolve();
    }

    /** Uma conexão SSH: sessões encadeadas (jump hosts) + um shell interativo na última. */
    private class SshConn {
        final String sid;
        final List<Session> sessions = new ArrayList<>();
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        ChannelShell channel;
        OutputStream out;
        volatile boolean closed = false;

        SshConn(String sid) {
            this.sid = sid;
        }

        void open(JSArray hops, JSArray forwards, int cols, int rows) throws Exception {
            Session prev = null;
            for (int i = 0; i < hops.length(); i++) {
                JSONObject h = hops.getJSONObject(i);
                String host = h.getString("host");
                int port = h.optInt("port", 22);
                String user = h.getString("username");
                String pass = h.optString("password", "");
                boolean legacy = h.optBoolean("legacy", true);
                String name = h.optString("name", host);

                String connectHost = host;
                int connectPort = port;
                if (prev != null) {
                    // jump host: abre um túnel local pela sessão anterior até o próximo equipamento
                    connectPort = prev.setPortForwardingL(0, host, port);
                    connectHost = "127.0.0.1";
                }
                status(sid, (i < hops.length() - 1 ? "Jump host: " : "Conectando: ") + host + ":" + port + "...");

                JSch jsch = new JSch();
                Session s = jsch.getSession(user, connectHost, connectPort);
                s.setPassword(pass);
                s.setUserInfo(new PasswordInfo(pass));
                s.setConfig("StrictHostKeyChecking", "yes");
                s.setConfig("PreferredAuthentications", "password,keyboard-interactive");
                s.setHostKeyRepository(new AskRepository(sid, i, host + ":" + port));
                if (legacy) {
                    applyLegacy(s);
                }
                s.setServerAliveInterval(15000);
                s.setServerAliveCountMax(4);
                s.connect(25000);
                sessions.add(s);
                prev = s;
            }

            final Session last = sessions.get(sessions.size() - 1);
            if (forwards != null) {
                for (int i = 0; i < forwards.length(); i++) {
                    startForward(last, forwards.getString(i));
                }
            }

            channel = (ChannelShell) last.openChannel("shell");
            channel.setPtyType("xterm-256color", cols, rows, 0, 0);
            final InputStream in = channel.getInputStream();
            out = channel.getOutputStream();
            channel.connect(15000);

            Thread reader = new Thread(new Runnable() {
                @Override
                public void run() {
                    byte[] buf = new byte[8192];
                    try {
                        int n;
                        while ((n = in.read(buf)) >= 0) {
                            if (n > 0) {
                                JSObject o = new JSObject();
                                o.put("sid", sid);
                                o.put("b64", b64(buf, n));
                                emit("data", o);
                            }
                        }
                    } catch (Exception ignored) {
                        // conexão caiu: tratado abaixo
                    }
                    close("Sessão encerrada");
                }
            }, "netdeck-ssh-" + sid);
            reader.setDaemon(true);
            reader.start();
        }

        private void startForward(Session s, String line) {
            String[] p = line.trim().split(":");
            try {
                if (p.length == 4 && p[0].equalsIgnoreCase("L")) {
                    s.setPortForwardingL(Integer.parseInt(p[1]), p[2], Integer.parseInt(p[3]));
                    status(sid, "Túnel 127.0.0.1:" + p[1] + " -> " + p[2] + ":" + p[3]);
                } else if (p.length == 2 && p[0].equalsIgnoreCase("D")) {
                    status(sid, "Túnel SOCKS5 (D:" + p[1] + ") não é suportado no Android");
                } else {
                    status(sid, "Túnel ignorado (formato inválido): " + line);
                }
            } catch (Exception e) {
                status(sid, "Túnel " + line + ": " + e.getMessage());
            }
        }

        void write(final byte[] data) {
            if (closed || out == null) {
                return;
            }
            writer.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        out.write(data);
                        out.flush();
                    } catch (Exception e) {
                        close("Conexão encerrada");
                    }
                }
            });
        }

        void resize(int cols, int rows) {
            if (channel != null && !closed) {
                channel.setPtySize(cols, rows, 0, 0);
            }
        }

        /** reason != null: avisa a interface que a sessão terminou. */
        synchronized void close(String reason) {
            if (closed) {
                return;
            }
            closed = true;
            try {
                if (channel != null) {
                    channel.disconnect();
                }
            } catch (Exception ignored) {
                // ignora
            }
            for (int i = sessions.size() - 1; i >= 0; i--) {
                try {
                    sessions.get(i).disconnect();
                } catch (Exception ignored) {
                    // ignora
                }
            }
            writer.shutdownNow();
            sshConns.remove(sid);
            if (reason != null) {
                JSObject o = new JSObject();
                o.put("sid", sid);
                o.put("reason", reason);
                emit("closed", o);
            }
        }
    }

    /** Equipamentos antigos só falam algoritmos hoje considerados fracos: são ACRESCENTADOS ao fim, não substituem os modernos. */
    private static void applyLegacy(Session s) {
        add(s, "kex", "diffie-hellman-group14-sha1,diffie-hellman-group1-sha1,diffie-hellman-group-exchange-sha1");
        add(s, "server_host_key", "ssh-rsa,ssh-dss");
        add(s, "cipher.s2c", "aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc");
        add(s, "cipher.c2s", "aes128-cbc,aes192-cbc,aes256-cbc,3des-cbc");
        add(s, "mac.s2c", "hmac-sha1,hmac-md5");
        add(s, "mac.c2s", "hmac-sha1,hmac-md5");
    }

    private static void add(Session s, String key, String extra) {
        String cur = JSch.getConfig(key);
        s.setConfig(key, (cur == null || cur.isEmpty()) ? extra : cur + "," + extra);
    }

    /** Usuário/senha para a autenticação (inclusive keyboard-interactive, que muitos switches usam no lugar de "password"). */
    private static class PasswordInfo implements UserInfo, UIKeyboardInteractive {
        private final String pass;

        PasswordInfo(String pass) {
            this.pass = pass;
        }

        @Override
        public String getPassphrase() {
            return null;
        }

        @Override
        public String getPassword() {
            return pass;
        }

        @Override
        public boolean promptPassword(String message) {
            return true;
        }

        @Override
        public boolean promptPassphrase(String message) {
            return false;
        }

        @Override
        public boolean promptYesNo(String message) {
            return false;
        }

        @Override
        public void showMessage(String message) {
            // nada
        }

        @Override
        public String[] promptKeyboardInteractive(String destination, String name, String instruction, String[] prompt, boolean[] echo) {
            String[] r = new String[prompt.length];
            Arrays.fill(r, pass);
            return r;
        }
    }

    /**
     * Confiança na chave do servidor: a decisão é da interface (que conhece as chaves já aceitas e pergunta ao usuário).
     * Só "OK" deixa a conexão seguir; qualquer outra resposta derruba antes de enviar a senha.
     */
    private class AskRepository implements HostKeyRepository {
        private final String sid;
        private final int hop;
        private final String hostport;

        AskRepository(String sid, int hop, String hostport) {
            this.sid = sid;
            this.hop = hop;
            this.hostport = hostport;
        }

        @Override
        public int check(String host, byte[] key) {
            String slot = sid + ":" + hop;
            try {
                String algo = new HostKey(host, key).getType();
                String fp = "SHA256:" + Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(key), Base64.NO_WRAP | Base64.NO_PADDING);
                CompletableFuture<Boolean> f = new CompletableFuture<>();
                keyAnswers.put(slot, f);
                JSObject o = new JSObject();
                o.put("sid", sid);
                o.put("hop", hop);
                o.put("hostport", hostport);
                o.put("algo", algo);
                o.put("fp", fp);
                emit("hostkey", o);
                boolean ok = f.get(120, TimeUnit.SECONDS);
                return ok ? OK : NOT_INCLUDED;
            } catch (Exception e) {
                return NOT_INCLUDED;
            } finally {
                keyAnswers.remove(slot);
            }
        }

        @Override
        public void add(HostKey hostkey, UserInfo ui) {
            // a interface guarda as chaves aceitas
        }

        @Override
        public void remove(String host, String type) {
            // não usado
        }

        @Override
        public void remove(String host, String type, byte[] key) {
            // não usado
        }

        @Override
        public String getKnownHostsRepositoryID() {
            return "netdeck";
        }

        @Override
        public HostKey[] getHostKey() {
            return new HostKey[0];
        }

        @Override
        public HostKey[] getHostKey(String host, String type) {
            return new HostKey[0];
        }
    }

    // ------------------------------------------------------------------ TCP (Telnet)

    @PluginMethod
    public void tcpOpen(final PluginCall call) {
        final String sid = call.getString("sid");
        final String host = call.getString("host");
        final int port = call.getInt("port", 23);
        final int timeout = call.getInt("timeout", 20000);
        if (sid == null || host == null) {
            call.reject("Parâmetros inválidos");
            return;
        }
        pool.execute(new Runnable() {
            @Override
            public void run() {
                final TcpConn c = new TcpConn();
                try {
                    c.socket = new Socket();
                    c.socket.connect(new InetSocketAddress(host, port), timeout);
                    c.socket.setKeepAlive(true);
                    tcpConns.put(sid, c);
                    call.resolve();
                } catch (Exception e) {
                    c.shutdown();
                    call.reject(explain(e));
                    return;
                }
                byte[] buf = new byte[8192];
                String error = null;
                try {
                    InputStream in = c.socket.getInputStream();
                    int n;
                    while ((n = in.read(buf)) >= 0) {
                        if (n > 0) {
                            JSObject o = new JSObject();
                            o.put("sid", sid);
                            o.put("b64", b64(buf, n));
                            emit("tcpdata", o);
                        }
                    }
                } catch (Exception e) {
                    if (!c.closed) {
                        error = e.getMessage();
                    }
                }
                tcpConns.remove(sid);
                c.shutdown();
                JSObject o = new JSObject();
                o.put("sid", sid);
                if (error != null) {
                    o.put("error", error);
                }
                emit("tcpclosed", o);
            }
        });
    }

    @PluginMethod
    public void tcpWrite(PluginCall call) {
        final TcpConn c = tcpConns.get(call.getString("sid"));
        String b64 = call.getString("b64");
        if (c != null && b64 != null) {
            final byte[] data = Base64.decode(b64, Base64.NO_WRAP);
            c.writer.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        OutputStream os = c.socket.getOutputStream();
                        os.write(data);
                        os.flush();
                    } catch (Exception ignored) {
                        c.shutdown();
                    }
                }
            });
        }
        call.resolve();
    }

    @PluginMethod
    public void tcpClose(PluginCall call) {
        TcpConn c = tcpConns.remove(call.getString("sid"));
        if (c != null) {
            c.shutdown();
        }
        call.resolve();
    }

    private static class TcpConn {
        Socket socket;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        volatile boolean closed = false;

        void shutdown() {
            closed = true;
            try {
                if (socket != null) {
                    socket.close();
                }
            } catch (Exception ignored) {
                // ignora
            }
            writer.shutdownNow();
        }
    }
}
