import { getClientIp } from '../../src/utils/clientIp';

const req = (headers: Record<string, string>) => new Request('http://localhost/', { headers });

describe('getClientIp', () => {
  it('reads CloudFront-Viewer-Address and strips the port (IPv4)', () => {
    expect(getClientIp(req({ 'CloudFront-Viewer-Address': '203.0.113.7:46532' }))).toBe('203.0.113.7');
  });

  it('strips the port at the last colon for unbracketed IPv6', () => {
    expect(getClientIp(req({ 'CloudFront-Viewer-Address': '2001:db8:4::1:46532' }))).toBe('2001:db8:4::1');
  });

  it('tolerates the bracketed [v6]:port form', () => {
    expect(getClientIp(req({ 'CloudFront-Viewer-Address': '[2001:db8::1]:443' }))).toBe('2001:db8::1');
  });

  it('prefers CloudFront-Viewer-Address over X-Forwarded-For', () => {
    expect(getClientIp(req({
      'CloudFront-Viewer-Address': '198.51.100.1:1234',
      'X-Forwarded-For': '10.0.0.1, 10.0.0.2',
    }))).toBe('198.51.100.1');
  });

  it('falls back to the first X-Forwarded-For entry', () => {
    expect(getClientIp(req({ 'X-Forwarded-For': ' 198.51.100.9 , 10.0.0.2, 10.0.0.3' }))).toBe('198.51.100.9');
  });

  it('returns null without either header', () => {
    expect(getClientIp(req({}))).toBeNull();
    expect(getClientIp(req({ 'X-Forwarded-For': ' , ' }))).toBeNull();
  });

  it('ignores CF-Connecting-IP (Cloudflare is gone)', () => {
    expect(getClientIp(req({ 'CF-Connecting-IP': '192.0.2.1' }))).toBeNull();
  });
});
