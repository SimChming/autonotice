// Package contentfetch downloads and parses group files, links and miniapp
// cards, with SSRF protection, a Jina Reader fallback and blocked-content
// heuristics.
package contentfetch

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrBlockedAddress is returned when a target resolves to a non-public address.
var ErrBlockedAddress = errors.New("contentfetch: blocked non-public address")

// SafeDialer resolves a hostname and refuses to connect to private/reserved
// addresses, defeating DNS rebinding by validating the resolved IP right before
// dialing.
type SafeDialer struct {
	dialer   *net.Dialer
	resolver *net.Resolver
}

// NewSafeDialer builds an SSRF-safe dialer.
func NewSafeDialer(connectTimeout time.Duration) *SafeDialer {
	if connectTimeout <= 0 {
		connectTimeout = 5 * time.Second
	}
	return &SafeDialer{
		dialer:   &net.Dialer{Timeout: connectTimeout, KeepAlive: 30 * time.Second},
		resolver: net.DefaultResolver,
	}
}

// DialContext implements the transport dial hook.
func (d *SafeDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	if !allowedPort(port) {
		return nil, fmt.Errorf("contentfetch: blocked port %s", port)
	}
	ips, err := d.resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for _, ip := range ips {
		if !isPublicIP(ip) {
			lastErr = fmt.Errorf("%w: %s", ErrBlockedAddress, ip.String())
			continue
		}
		conn, err := d.dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		if err != nil {
			lastErr = err
			continue
		}
		return conn, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("contentfetch: no usable address for %s", host)
	}
	return nil, lastErr
}

func (d *SafeDialer) resolve(ctx context.Context, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	addrs, err := d.resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ips = append(ips, a.IP)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("contentfetch: no addresses for %s", host)
	}
	return ips, nil
}

func allowedPort(port string) bool {
	switch port {
	case "80", "443", "8080":
		return true
	default:
		return false
	}
}

// isPublicIP rejects loopback, private, link-local, multicast and reserved ranges.
func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsUnspecified() || ip.IsMulticast() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() {
		return false
	}
	if ip.IsPrivate() {
		return false // 10/8, 172.16/12, 192.168/16, fc00::/7
	}
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127:
			return false // 100.64.0.0/10 CGNAT
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0:
			return false // 192.0.0.0/24
		case v4[0] == 198 && (v4[1] == 18 || v4[1] == 19):
			return false // 198.18.0.0/15
		case v4[0] >= 240:
			return false // 240.0.0.0/4 reserved
		}
		return true
	}
	if len(ip) == 16 {
		if ip[0] == 0xfc || ip[0] == 0xfd {
			return false // unique local
		}
	}
	return true
}

// ValidateURL enforces the http(s) scheme and the allowed port set.
func ValidateURL(rawURL string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return nil, fmt.Errorf("contentfetch: unsupported scheme %q", u.Scheme)
	}
	if u.Host == "" {
		return nil, errors.New("contentfetch: missing host")
	}
	if p := u.Port(); p != "" && !allowedPort(p) {
		return nil, fmt.Errorf("contentfetch: blocked port %s", p)
	}
	return u, nil
}

// SafeClient builds an http.Client with an SSRF-safe transport and a redirect
// guard that re-validates every hop and caps the chain at 5.
func SafeClient(connectTimeout, totalTimeout time.Duration) *http.Client {
	if totalTimeout <= 0 {
		totalTimeout = 20 * time.Second
	}
	d := NewSafeDialer(connectTimeout)
	tr := &http.Transport{
		Proxy:                 nil,
		DialContext:           d.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
		ResponseHeaderTimeout: totalTimeout,
	}
	client := &http.Client{Transport: tr, Timeout: totalTimeout}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("contentfetch: too many redirects")
		}
		if _, err := ValidateURL(req.URL.String()); err != nil {
			return err
		}
		return nil
	}
	return client
}
