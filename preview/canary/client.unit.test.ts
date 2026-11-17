import { describe, expect, it } from "bun:test";
import {
  bearer,
  parseMcpBody,
  parseQueueTasksBlocked,
  parseSessionCookie,
  poll,
} from "./client.ts";

describe("parseQueueTasksBlocked", () => {
  it("reads tasksBlocked from the metrics { data, meta } envelope", () => {
    expect(
      parseQueueTasksBlocked({ data: { tasksBlocked: 3 }, meta: {} }),
    ).toBe(3);
  });

  it("reads a zero count", () => {
    expect(parseQueueTasksBlocked({ data: { tasksBlocked: 0 } })).toBe(0);
  });

  it("throws on an unwrapped body instead of yielding undefined", () => {
    expect(() => parseQueueTasksBlocked({ tasksBlocked: 3 })).toThrow(
      "data.tasksBlocked",
    );
  });

  it("throws on a null body", () => {
    expect(() => parseQueueTasksBlocked(null)).toThrow("data.tasksBlocked");
  });
});

describe("parseSessionCookie", () => {
  it("returns the name=value pair of the admin_session cookie", () => {
    expect(
      parseSessionCookie([
        "other=1; Path=/",
        "admin_session=abc.def; HttpOnly; Max-Age=604800",
      ]),
    ).toBe("admin_session=abc.def");
  });

  it("returns undefined when no admin_session cookie is set", () => {
    expect(parseSessionCookie(["other=1"])).toBeUndefined();
  });
});

describe("parseMcpBody", () => {
  it("parses a plain JSON body", () => {
    expect(parseMcpBody("application/json", '{"id":1}')).toEqual({ id: 1 });
  });

  it("parses the data line of an SSE body", () => {
    expect(
      parseMcpBody("text/event-stream", 'event: message\ndata: {"id":2}\n\n'),
    ).toEqual({ id: 2 });
  });

  it("throws when an SSE body has no data line", () => {
    expect(() => parseMcpBody("text/event-stream", "event: ping\n")).toThrow(
      "no data line",
    );
  });
});

describe("bearer", () => {
  it("builds an Authorization header", () => {
    expect(bearer("t")).toEqual({ Authorization: "Bearer t" });
  });
});

describe("poll", () => {
  it("returns the first defined value", async () => {
    let calls = 0;
    const out = await poll(
      async () => (++calls === 3 ? "done" : undefined),
      1000,
      1,
    );
    expect(out).toBe("done");
  });

  it("returns undefined once the timeout elapses", async () => {
    expect(await poll(async () => undefined, 20, 5)).toBeUndefined();
  });
});
