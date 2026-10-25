#!/usr/bin/env python3
"""Serve the built app over HTTPS on the local network.

Browsers only allow camera access on https:// or localhost, so an iPhone or a
second computer can receive files only over HTTPS. This script:

  * creates (once) a small local certificate authority in ~/.qr-air-transfer,
    restricted by name constraints to *.local names and private IP addresses,
    so trusting it on a phone cannot be abused for real websites;
  * issues a server certificate for this computer's Bonjour name and LAN IPs;
  * serves the app folder over HTTPS and offers the CA certificate at
    /qr-air-ca.crt for installing on iPhone/iPad.

Keys never live in the served folder. Only macOS/Linux built-ins are used:
python3 (3.7+) and the openssl command (OpenSSL or LibreSSL).

Usage:  python3 serve-https.py [folder] [--port 8443] [--name my-mac]
"""

import argparse
import http.server
import ipaddress
import os
import platform
import socket
import ssl
import subprocess
import sys
import tempfile

STATE_DIR = os.path.join(os.path.expanduser("~"), ".qr-air-transfer")
CA_KEY = os.path.join(STATE_DIR, "ca-key.pem")
CA_CERT = os.path.join(STATE_DIR, "qr-air-ca.pem")
CA_SERIAL = os.path.join(STATE_DIR, "ca.srl")
SERVER_KEY = os.path.join(STATE_DIR, "server-key.pem")
SERVER_CERT = os.path.join(STATE_DIR, "server-cert.pem")
CA_PATH = "/qr-air-ca.crt"

# The CA may only vouch for these names; anything else fails validation.
PERMITTED_NETS = [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "100.64.0.0/10",
    "127.0.0.0/8",
]


def run_openssl(args, cwd):
    result = subprocess.run(["openssl"] + args, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit("openssl failed: openssl %s\n%s" % (" ".join(args), result.stderr))


def write(path, text):
    with open(path, "w") as f:
        f.write(text)


def ensure_ca():
    if os.path.exists(CA_KEY) and os.path.exists(CA_CERT):
        return
    os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
    nets = []
    for net in PERMITTED_NETS:
        n = ipaddress.ip_network(net)
        nets.append("permitted;IP:%s/%s" % (n.network_address, n.netmask))
    constraints = ", ".join(["permitted;DNS:local", "permitted;DNS:localhost"] + nets)
    with tempfile.TemporaryDirectory() as tmp:
        write(
            os.path.join(tmp, "ca.cnf"),
            "[req]\nprompt = no\ndistinguished_name = dn\n"
            "[dn]\nCN = QR Air Transfer local CA (%s)\nO = QR Air Transfer\n"
            "[v3_ca]\nbasicConstraints = critical, CA:TRUE, pathlen:0\n"
            "keyUsage = critical, keyCertSign, cRLSign\n"
            "subjectKeyIdentifier = hash\n"
            "nameConstraints = critical, %s\n" % (socket.gethostname(), constraints),
        )
        run_openssl(
            ["req", "-x509", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256", "-days", "825",
             "-keyout", CA_KEY, "-out", CA_CERT, "-config", "ca.cnf", "-extensions", "v3_ca"],
            tmp,
        )
    os.chmod(CA_KEY, 0o600)


def bonjour_name(override):
    if override:
        return override.lower().replace(".local", "")
    if platform.system() == "Darwin":
        try:
            out = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True)
            if out.returncode == 0 and out.stdout.strip():
                return out.stdout.strip().lower()
        except OSError:
            pass
    return socket.gethostname().split(".")[0].lower()


def lan_ips():
    """Private IPv4 addresses of this machine (the ones a phone could reach)."""
    found = []

    def add(ip):
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return
        if addr.version == 4 and not addr.is_loopback and ip not in found:
            if any(addr in ipaddress.ip_network(n) for n in PERMITTED_NETS):
                found.append(ip)

    if platform.system() == "Darwin":
        for iface in ("en0", "en1", "en2", "bridge100"):
            out = subprocess.run(["ipconfig", "getifaddr", iface], capture_output=True, text=True)
            add(out.stdout.strip())
    # Address of the interface that routes to a private network (sends no packets).
    for target in ("192.168.0.1", "10.255.255.255"):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((target, 1))
            add(s.getsockname()[0])
        except OSError:
            pass
        finally:
            s.close()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except OSError:
        pass
    return found


def issue_server_cert(name, ips):
    """A fresh leaf certificate each run, so a changed IP is always covered."""
    sans = ["DNS:%s.local" % name, "DNS:localhost", "IP:127.0.0.1"] + ["IP:%s" % ip for ip in ips]
    with tempfile.TemporaryDirectory() as tmp:
        write(os.path.join(tmp, "req.cnf"), "[req]\nprompt = no\ndistinguished_name = dn\n[dn]\nCN = %s.local\n" % name)
        write(
            os.path.join(tmp, "leaf.cnf"),
            "[v3_leaf]\nbasicConstraints = critical, CA:FALSE\n"
            "keyUsage = critical, digitalSignature, keyEncipherment\n"
            "extendedKeyUsage = serverAuth\n"
            "subjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid\n"
            "subjectAltName = %s\n" % ", ".join(sans),
        )
        run_openssl(["req", "-new", "-nodes", "-newkey", "rsa:2048", "-sha256",
                     "-keyout", SERVER_KEY, "-out", "leaf.csr", "-config", "req.cnf"], tmp)
        # 397 days: the longest validity Apple accepts for TLS server certificates.
        run_openssl(["x509", "-req", "-in", "leaf.csr", "-sha256", "-days", "397",
                     "-CA", CA_CERT, "-CAkey", CA_KEY, "-CAserial", CA_SERIAL, "-CAcreateserial",
                     "-out", SERVER_CERT, "-extfile", "leaf.cnf", "-extensions", "v3_leaf"], tmp)
    os.chmod(SERVER_KEY, 0o600)


def default_folder():
    here = os.path.dirname(os.path.abspath(__file__))
    for candidate in (here, os.path.join(os.getcwd(), "dist"), os.path.join(here, "..", "dist"), os.getcwd()):
        if os.path.isfile(os.path.join(candidate, "index.html")):
            return os.path.abspath(candidate)
    return None


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(
        http.server.SimpleHTTPRequestHandler.extensions_map,
        **{
            ".wasm": "application/wasm",
            ".js": "text/javascript",
            ".mjs": "text/javascript",
            ".webmanifest": "application/manifest+json",
            ".svg": "image/svg+xml",
        }
    )

    timeout = 30

    def setup(self):
        # TLS handshake here, in the per-connection thread, not in accept().
        self.request.settimeout(self.timeout)
        self.request.do_handshake()
        super().setup()

    def do_GET(self):
        if self.path.split("?")[0] == CA_PATH:
            with open(CA_CERT, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/x-x509-ca-cert")
            self.send_header("Content-Disposition", 'attachment; filename="qr-air-ca.crt"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        # Only report problems; a page load is dozens of successful requests.
        if len(args) >= 2 and str(args[1]).startswith(("2", "3")):
            return
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class DualStackServer(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6

    daemon_threads = True

    def handle_error(self, request, client_address):
        # Browsers abort handshakes while the certificate is not yet trusted — not worth a traceback.
        err = sys.exc_info()[1]
        if isinstance(err, (ssl.SSLError, ConnectionError, socket.timeout)):
            return
        super().handle_error(request, client_address)

    def server_bind(self):
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


def main():
    parser = argparse.ArgumentParser(description="Serve QR Air Transfer over HTTPS on the local network.")
    parser.add_argument("folder", nargs="?", help="folder with index.html (default: next to this script or ./dist)")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--name", help="Bonjour name of this computer (default: detected)")
    opts = parser.parse_args()

    folder = os.path.abspath(opts.folder) if opts.folder else default_folder()
    if not folder or not os.path.isfile(os.path.join(folder, "index.html")):
        sys.exit("No index.html found. Pass the app folder, e.g.: python3 serve-https.py ~/Downloads/QR-Air-Transfer")

    ensure_ca()
    name = bonjour_name(opts.name)
    ips = lan_ips()
    issue_server_cert(name, ips)

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(SERVER_CERT, SERVER_KEY)

    def handler(*args, **kwargs):
        return Handler(*args, directory=folder, **kwargs)

    try:
        httpd = DualStackServer(("::", opts.port), handler)
    except OSError:
        DualStackServer.address_family = socket.AF_INET
        httpd = DualStackServer(("0.0.0.0", opts.port), handler)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True, do_handshake_on_connect=False)

    port = opts.port
    print("\nQR Air Transfer — HTTPS server for %s\n" % folder)
    print("  On this computer:      https://localhost:%d" % port)
    print("  iPhone / other Mac:    https://%s.local:%d" % (name, port))
    for ip in ips:
        print("                         https://%s:%d" % (ip, port))
    print("\n  Certificate for iPhone (install once, see README):  https://%s.local:%d%s" % (name, port, CA_PATH))
    print("  The same file on this Mac:  %s" % CA_CERT)
    print("\nAllow incoming connections if macOS asks. Stop with Ctrl+C.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
