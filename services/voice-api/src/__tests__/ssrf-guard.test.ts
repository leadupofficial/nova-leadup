import { describe, it, expect } from 'vitest';
import { isUrlSafe } from '../utils/ssrf-guard';

describe('isUrlSafe — SSRF guard', () => {
  describe('allowed public URLs', () => {
    it('allows https public URLs', () => {
      const result = isUrlSafe('https://example.com/audio.mp3');
      expect(result.safe).toBe(true);
    });

    it('allows http public URLs', () => {
      const result = isUrlSafe('http://example.com/audio.mp3');
      expect(result.safe).toBe(true);
    });

    it('allows URLs with standard ports', () => {
      const result = isUrlSafe('https://example.com:443/audio.mp3');
      expect(result.safe).toBe(true);
    });
  });

  describe('blocked private IPv4 ranges', () => {
    it('blocks 127.0.0.1 (loopback)', () => {
      const result = isUrlSafe('http://127.0.0.1/audio.mp3');
      expect(result.safe).toBe(false);
      expect(result.reason).toBeTruthy();
    });

    it('blocks 127.x.x.x loopback range', () => {
      const result = isUrlSafe('http://127.0.0.2/audio.mp3');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Private/reserved');
    });

    it('blocks 10.0.0.0/8 private range', () => {
      const result = isUrlSafe('http://10.0.0.1/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks 172.16.0.0/12 private range', () => {
      const result = isUrlSafe('http://172.16.0.1/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks 172.31.255.254 (upper bound)', () => {
      const result = isUrlSafe('http://172.31.255.254/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('allows 172.32.0.0/12 (not private)', () => {
      const result = isUrlSafe('http://172.32.0.1/audio.mp3');
      expect(result.safe).toBe(true);
    });

    it('blocks 192.168.0.0/16 private range', () => {
      const result = isUrlSafe('http://192.168.1.1/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks 169.254.0.0/16 link-local / cloud metadata', () => {
      const result = isUrlSafe('http://169.254.169.254/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks 0.0.0.0/8', () => {
      const result = isUrlSafe('http://0.0.0.1/audio.mp3');
      expect(result.safe).toBe(false);
      expect(result.reason).toContain('Private/reserved');
    });

    it('blocks 100.64.0.0/10 carrier-grade NAT', () => {
      const result = isUrlSafe('http://100.64.0.1/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks 198.18.0.0/15 benchmark tests', () => {
      const result = isUrlSafe('http://198.18.0.1/audio.mp3');
      expect(result.safe).toBe(false);
    });
  });

  describe('blocked hosts', () => {
    it('blocks localhost hostname', () => {
      const result = isUrlSafe('http://localhost/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks 0.0.0.0 hostname', () => {
      const result = isUrlSafe('http://0.0.0.0/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks ::1 IPv6 loopback', () => {
      const result = isUrlSafe('http://[::1]/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks fc00::/7 unique local IPv6', () => {
      const result = isUrlSafe('http://[fc00::1]/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks fd00::/8 unique local IPv6', () => {
      const result = isUrlSafe('http://[fd00::1]/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks fe80::/10 link-local IPv6', () => {
      const result = isUrlSafe('http://[fe80::1]/audio.mp3');
      expect(result.safe).toBe(false);
    });
  });

  describe('blocked protocols', () => {
    it('blocks file:// protocol', () => {
      const result = isUrlSafe('file:///etc/passwd');
      expect(result.safe).toBe(false);
    });

    it('blocks ftp:// protocol', () => {
      const result = isUrlSafe('ftp://internal-ftp/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks gopher:// protocol', () => {
      const result = isUrlSafe('gopher://127.0.0.1/');
      expect(result.safe).toBe(false);
    });
  });

  describe('blocked sensitive ports', () => {
    it('blocks port 22 (SSH)', () => {
      const result = isUrlSafe('http://example.com:22/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks port 3306 (MySQL)', () => {
      const result = isUrlSafe('http://example.com:3306/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks port 5432 (PostgreSQL)', () => {
      const result = isUrlSafe('http://example.com:5432/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks port 6379 (Redis)', () => {
      const result = isUrlSafe('http://example.com:6379/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks port 9200 (Elasticsearch)', () => {
      const result = isUrlSafe('http://example.com:9200/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('blocks port 27017 (MongoDB)', () => {
      const result = isUrlSafe('http://example.com:27017/audio.mp3');
      expect(result.safe).toBe(false);
    });

    it('allows non-sensitive port 8080', () => {
      const result = isUrlSafe('http://example.com:8080/audio.mp3');
      expect(result.safe).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty string', () => {
      const result = isUrlSafe('');
      expect(result.safe).toBe(false);
    });

    it('rejects non-HTTP URLs', () => {
      const result = isUrlSafe('javascript:alert(1)');
      expect(result.safe).toBe(false);
    });
  });
});
