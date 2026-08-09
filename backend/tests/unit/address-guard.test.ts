import { describe, expect, it } from "vitest";

import { classifyAddress, isPublicAddress } from "../../src/connections/address-guard.js";

describe("the tailnet range", () => {
  it("should refuse 100.64.0.0/10, which is where every tailnet machine lives", () => {
    // THE block that matters. Tailscale assigns out of CGNAT, so Syl's own
    // API, Adjutant's backend and the Commander's Mac all sit at 100.x.y.z —
    // neither loopback nor RFC 1918. A hostile article redirecting there
    // reaches Syl from inside her own trust zone.
    expect(classifyAddress("100.64.0.0")).toBe("carrier_grade_nat");
    expect(classifyAddress("100.100.42.7")).toBe("carrier_grade_nat");
    expect(classifyAddress("100.127.255.255")).toBe("carrier_grade_nat");
  });

  it("should not over-reach into the public addresses either side of it", () => {
    // 100.64.0.0/10 is 100.64.0.0 – 100.127.255.255. Blocking 100.0.0.0/8
    // would be wrong in the other direction.
    expect(classifyAddress("100.63.255.255")).toBe("public");
    expect(classifyAddress("100.128.0.0")).toBe("public");
  });
});

describe("classifyAddress, IPv4", () => {
  it("should refuse loopback", () => {
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("127.255.255.254")).toBe("loopback");
  });

  it("should refuse every RFC 1918 range", () => {
    expect(classifyAddress("10.0.0.1")).toBe("private");
    expect(classifyAddress("172.16.0.1")).toBe("private");
    expect(classifyAddress("172.31.255.255")).toBe("private");
    expect(classifyAddress("192.168.1.1")).toBe("private");
  });

  it("should not refuse the addresses just outside 172.16.0.0/12", () => {
    expect(classifyAddress("172.15.255.255")).toBe("public");
    expect(classifyAddress("172.32.0.0")).toBe("public");
  });

  it("should refuse the cloud metadata endpoint", () => {
    // Historically the single most productive SSRF target in existence.
    expect(classifyAddress("169.254.169.254")).toBe("link_local");
  });

  it("should refuse multicast, broadcast and the reserved space", () => {
    expect(classifyAddress("224.0.0.1")).toBe("multicast");
    expect(classifyAddress("255.255.255.255")).toBe("reserved");
    expect(classifyAddress("0.0.0.0")).toBe("reserved");
    expect(classifyAddress("240.0.0.1")).toBe("reserved");
  });

  it("should allow ordinary public addresses", () => {
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("93.184.216.34")).toBe("public");
    expect(classifyAddress("1.1.1.1")).toBe("public");
  });

  it("should call a malformed address malformed rather than public", () => {
    // Failing open on an unparseable address is the worst available outcome.
    expect(classifyAddress("999.1.1.1")).toBe("malformed");
    expect(classifyAddress("10.0.0")).toBe("malformed");
    expect(classifyAddress("")).toBe("malformed");
    expect(classifyAddress("localhost")).toBe("malformed");
    expect(classifyAddress("10.0.0.01abc")).toBe("malformed");
  });
});

describe("classifyAddress, IPv6", () => {
  it("should refuse loopback and the unspecified address", () => {
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("::")).toBe("reserved");
  });

  it("should refuse unique local addresses", () => {
    expect(classifyAddress("fc00::1")).toBe("unique_local");
    expect(classifyAddress("fd12:3456:789a::1")).toBe("unique_local");
  });

  it("should refuse link local and multicast", () => {
    expect(classifyAddress("fe80::1")).toBe("link_local");
    expect(classifyAddress("fe80::1%en0")).toBe("link_local");
    expect(classifyAddress("ff02::1")).toBe("multicast");
  });

  it("should see through an IPv4-mapped address", () => {
    // `::ffff:127.0.0.1` must be refused for exactly the reasons `127.0.0.1`
    // is. Treating the two differently is how a block list gets walked around.
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
    expect(classifyAddress("::ffff:100.100.42.7")).toBe("carrier_grade_nat");
    expect(classifyAddress("::ffff:8.8.8.8")).toBe("public");
  });

  it("should see through a NAT64 address", () => {
    expect(classifyAddress("64:ff9b::100.100.42.7")).toBe("carrier_grade_nat");
    expect(classifyAddress("64:ff9b::8.8.8.8")).toBe("public");
  });

  it("should refuse 6to4, which embeds an IPv4 address it cannot check here", () => {
    expect(classifyAddress("2002:c0a8:0101::1")).toBe("reserved");
  });

  it("should allow an ordinary public IPv6 address", () => {
    expect(classifyAddress("2606:4700:4700::1111")).toBe("public");
    expect(classifyAddress("2001:4860:4860:0000:0000:0000:0000:8888")).toBe("public");
  });

  it("should call a malformed IPv6 address malformed", () => {
    expect(classifyAddress("::ffff:999.1.1.1")).toBe("malformed");
    expect(classifyAddress("fe80:::1")).toBe("malformed");
    expect(classifyAddress("gggg::1")).toBe("malformed");
  });
});

describe("isPublicAddress", () => {
  it("should be true only for addresses classified public", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("100.100.42.7")).toBe(false);
    expect(isPublicAddress("nonsense")).toBe(false);
  });
});
