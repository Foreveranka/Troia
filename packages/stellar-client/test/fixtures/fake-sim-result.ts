// A committed fake SimResult carrying a REAL-shaped Soroban footprint (contract-instance readOnly + SAC
// Balance readWrite + a resourceFee) AND a source-account auth entry, matching what live prepareTransaction
// returns for a require_auth(source) contract like pay(). This is the ONLY network-shaped input to the pure
// core in the offline suite; the real rpc-adapter is live-smoked separately.

import { Address, SorobanDataBuilder, xdr } from '@stellar/stellar-base';
import type { SimResult } from '../../src/outcomes.js';

export const DEFAULT_RESOURCE_FEE = '1234567';

/** A source-account SorobanAuthorizationEntry (no nonce) — what pay()'s require_auth(source) simulates to. */
export function sourceAuthXdr(contractId: string): string {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: 'pay',
        args: [],
      }),
    ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation,
  }).toXDR('base64');
}

/** A nonce-bearing ADDRESS credential entry — a non-source authorizer that assemble must reject. */
export function addressAuthXdr(contractId: string, authorizer: string): string {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contractId).toScAddress(),
        functionName: 'pay',
        args: [],
      }),
    ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(authorizer).toScAddress(),
        nonce: xdr.Int64.fromString('12345'),
        signatureExpirationLedger: 100_000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  }).toXDR('base64');
}

/** Build a plausible full footprint for pay() + a source-account auth entry, as a SimResult. `resourceFee`
 *  is exposed so a test can produce a DIFFERENT sim and prove the assembled hash is footprint-sensitive. */
export function fakeSimResult(
  troyPoolContractId: string,
  merchant: string,
  resourceFee: string = DEFAULT_RESOURCE_FEE,
): SimResult {
  const contract = new Address(troyPoolContractId).toScAddress();

  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract,
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const balanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract,
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Balance'), new Address(merchant).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const sorobanData = new SorobanDataBuilder()
    .setReadOnly([instanceKey])
    .setReadWrite([balanceKey])
    .setResourceFee(BigInt(resourceFee))
    .setResources(100_000, 2_000, 3_000)
    .build();

  return {
    sorobanDataXdr: sorobanData.toXDR('base64'),
    minResourceFee: resourceFee,
    authXdr: [sourceAuthXdr(troyPoolContractId)],
  };
}
