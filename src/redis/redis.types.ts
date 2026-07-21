export type RedisClient = {
  del(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<string | null>;
  setEx(key: string, seconds: number, value: string): Promise<string | null>;
  hGet(key: string, field: string): Promise<string | null | undefined>;
  hLen(key: string): Promise<number>;
  hSet(key: string, field: string, value: string): Promise<number>;
  hVals(key: string): Promise<string[]>;
  pExpire(key: string, milliseconds: number): Promise<boolean | number>;
  pTTL(key: string): Promise<number>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};
