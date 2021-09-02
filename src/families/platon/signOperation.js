// @flow

import invariant from "invariant";
import { Observable, from, of } from "rxjs";
import { mergeMap } from "rxjs/operators";
import eip55 from "eip55";
import { BigNumber } from "bignumber.js";
import { log } from "@ledgerhq/logs";
import { FeeNotLoaded } from "@ledgerhq/errors";
import Lat from "@ledgerhq/hw-app-lat";
import type { Transaction } from "./types";
import type { Operation, Account, SignOperationEvent } from "../../types";
import { getGasLimit, buildEthereumTx } from "./transaction";
import { apiForCurrency } from "../../api/Platon";
import { withDevice } from "../../hw/deviceAccess";
import { modes } from "./modules";
import { decodeBech32Address, isBech32Address } from "./utils.min.js";

export const signOperation = ({
  account,
  deviceId,
  transaction,
}: {
  account: Account,
  deviceId: *,
  transaction: Transaction,
}): Observable<SignOperationEvent> =>
  from(
    transaction.nonce !== undefined
      ? of(transaction.nonce)
      : apiForCurrency(account.currency).getAccountNonce(account.freshAddress)
  ).pipe(
    mergeMap((nonce) =>
      withDevice(deviceId)((transport) =>
        Observable.create((o) => {
          let cancelled;

          async function main() {
            // First, we need to create a partial tx and send to the device
            const { freshAddressPath, freshAddress } = account;
            const { gasPrice } = transaction;
            const gasLimit = getGasLimit(transaction);

            if (!gasPrice || !BigNumber(gasLimit).gt(0)) {
              log(
                "platon-error",
                "buildTransaction missingData: gasPrice=" +
                  String(gasPrice) +
                  " gasLimit=" +
                  String(gasLimit)
              );
              throw new FeeNotLoaded();
            }

            let bech32Adr = "";
            if (isBech32Address(transaction.recipient)) {
              bech32Adr = transaction.recipient;
              transaction.recipient = decodeBech32Address(
                transaction.recipient
              );
            }
            const { tx, fillTransactionDataResult } = buildEthereumTx(
              account,
              transaction,
              nonce
            );
            const to = eip55.encode("0x" + tx.to.toString("hex"));
            const chainId = tx.getChainId();
            const value = BigNumber("0x" + (tx.value.toString("hex") || "0"));

            const lat = new Lat(transport);

            o.next({ type: "device-signature-requested" });
            const result = await lat.signTransaction(
              freshAddressPath,
              tx.serialize().toString("hex")
            );
            if (cancelled) return;

            o.next({ type: "device-signature-granted" });

            // Second, we re-set some tx fields from the device signature

            let v = result.v;
            if (chainId > 0) {
              // EIP155 support. check/recalc signature v value.
              let rv = parseInt(v, 16);
              let cv = chainId * 2 + 35;
              if (rv !== cv && (rv & cv) !== rv) {
                cv += 1; // add signature v bit.
              }
              v = cv.toString(16);
            }

            tx.v = "0x" + v;
            tx.r = "0x" + result.r;
            tx.s = "0x" + result.s;

            // Generate the signature ready to be broadcasted
            const signature = `0x${tx.serialize().toString("hex")}`;

            // build optimistic operation
            const txHash = ""; // resolved at broadcast time
            const senders = [freshAddress];
            let recipients = [bech32Adr || to];
            const fee = gasPrice.times(gasLimit);
            const transactionSequenceNumber = nonce;
            const accountId = account.id;

            // currently, all mode are always at least one OUT tx on ETH parent
            const operation: $Exact<Operation> = {
              id: `${accountId}-${txHash}-OUT`,
              hash: txHash,
              transactionSequenceNumber,
              type: "OUT",
              value: BigNumber(value),
              fee,
              blockHash: null,
              blockHeight: null,
              senders,
              recipients,
              accountId,
              date: new Date(),
              extra: {},
            };

            const m = modes[transaction.mode];
            invariant(m, "missing module for mode=" + transaction.mode);
            m.fillOptimisticOperation(account, transaction, operation);

            o.next({
              type: "signed",
              signedOperation: {
                operation,
                signature,
                expirationDate: null,
              },
            });
          }

          main().then(
            () => o.complete(),
            (e) => o.error(e)
          );

          return () => {
            cancelled = true;
          };
        })
      )
    )
  );
