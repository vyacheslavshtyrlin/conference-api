export type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<string | null>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hLen(key: string): Promise<number>;
  hSet(key: string, field: string, value: string): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<boolean | number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};
