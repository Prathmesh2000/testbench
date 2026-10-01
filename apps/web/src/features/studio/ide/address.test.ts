import { describe, expect, it } from 'vitest';
import { toAddress } from './address';

describe('toAddress', () => {
  it('opens full URLs and bare hosts as sites', () => {
    expect(toAddress('https://justdial.com/x')).toBe('https://justdial.com/x');
    expect(toAddress('google.com')).toBe('https://google.com');
    expect(toAddress('shop.example.co.in/cart?id=1')).toBe('https://shop.example.co.in/cart?id=1');
    expect(toAddress('localhost:3000/login')).toBe('http://localhost:3000/login');
    expect(toAddress('192.168.1.5')).toBe('http://192.168.1.5');
  });

  it('searches for anything else', () => {
    expect(toAddress('google')).toBe('https://www.bing.com/search?q=google');
    expect(toAddress('best pizza mumbai')).toBe('https://www.bing.com/search?q=best%20pizza%20mumbai');
  });

  it('never opens other schemes', () => {
    expect(toAddress('javascript:alert(1)')).toBeNull();
    expect(toAddress('file:///etc/passwd')).toBeNull();
    expect(toAddress('   ')).toBeNull();
  });
});
