import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';

export type Numeric = bigint | number | string;
export type ScValEncoder<T = any> = (value: T) => xdr.ScVal;
export type ScValDecoder = (value: any) => any;

// ---------------------------------------------------------------------------
// ScVal encoders: TypeScript values -> xdr.ScVal
// ---------------------------------------------------------------------------
export const addressToScVal = (value: string): xdr.ScVal => Address.fromString(value).toScVal();
export const i128ToScVal = (value: Numeric): xdr.ScVal => nativeToScVal(BigInt(value), { type: 'i128' });
export const u64ToScVal = (value: Numeric): xdr.ScVal => nativeToScVal(BigInt(value), { type: 'u64' });
export const u32ToScVal = (value: number): xdr.ScVal => nativeToScVal(Number(value), { type: 'u32' });
export const boolToScVal = (value: boolean): xdr.ScVal => nativeToScVal(Boolean(value), { type: 'bool' });
export const stringToScVal = (value: string): xdr.ScVal => nativeToScVal(String(value), { type: 'string' });
export const vecToScVal = (items: xdr.ScVal[]): xdr.ScVal => xdr.ScVal.scvVec(items);

// ---------------------------------------------------------------------------
// ScVal decoders: xdr.ScVal (or an already-native value) -> TypeScript values.
// scValToNative already produces the correct JS primitive for each ScVal kind,
// so the decoders mainly normalize and are safe to compose.
// ---------------------------------------------------------------------------
export const decodeNative = <T>(value: xdr.ScVal | undefined | null): T | null => {
  if (value === undefined || value === null) return null;
  return scValToNative(value) as T;
};

export const decodeAddress = (value: unknown): string => String(value);
export const decodeI128 = (value: unknown): bigint => BigInt(value as bigint);
export const decodeU64 = (value: unknown): bigint => BigInt(value as bigint);
export const decodeU32 = (value: unknown): number => Number(value);
export const decodeBool = (value: unknown): boolean => value === true || value === 'true';
export const decodeString = (value: unknown): string => String(value);
export const decodeVec = <T>(decode: ScValDecoder) => (value: unknown): T[] =>
  Array.isArray(value) ? value.map((item) => decode(item) as T) : [];

// ---------------------------------------------------------------------------
// Named struct <-> ScVal mapping. #[contracttype] structs encode as an ScMap of
// field names, so the generated codecs only need a field -> codec table.
// ---------------------------------------------------------------------------
const isScVal = (value: unknown): value is xdr.ScVal =>
  Boolean(value) && typeof (value as xdr.ScVal).switch === 'function';

const toNative = (value: unknown): Record<string, unknown> => {
  const native = isScVal(value) ? scValToNative(value) : value;
  return (native ?? {}) as Record<string, unknown>;
};

export type StructFieldEncoders<T> = { [K in keyof T]: ScValEncoder<T[K]> };
export type StructFieldDecoders<T> = { [K in keyof T]: ScValDecoder };

export const encodeStruct = <T extends Record<string, unknown>>(
  fields: StructFieldEncoders<T>,
  value: T,
): xdr.ScVal =>
  xdr.ScVal.scvMap(
    (Object.keys(fields) as (keyof T)[]).map(
      (key) => new xdr.ScValMapEntry({ key: xdr.ScVal.scvSymbol(String(key)), val: fields[key](value[key]) }),
    ),
  );

export const decodeStruct = <T>(fields: StructFieldDecoders<T>, value: xdr.ScVal | unknown): T => {
  const native = toNative(value);
  return Object.fromEntries(
    (Object.keys(fields) as (keyof T)[]).map((key) => [key, fields[key](native[String(key)])]),
  ) as T;
};
