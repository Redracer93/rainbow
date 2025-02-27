import { logger } from '@/logger';
import { DebugContext } from '@/logger/debugContext';
import { getHdPath, WalletLibraryType } from '@/model/wallet';
import AppEth from '@ledgerhq/hw-app-eth';
import TransportBLE from '@ledgerhq/react-native-hw-transport-ble';
import { forEach } from 'lodash';
import * as i18n from '@/languages';

/**
 * Common Ledger Error Codes
 */
export enum LEDGER_ERROR_CODES {
  OFF_OR_LOCKED = 'off_or_locked',
  NO_ETH_APP = 'no_eth_app',
  UNKNOWN = 'unknown',
  DISCONNECTED = 'disconnected',
}

/**
 * Parses ledger errors based on common issues
 */
export const ledgerErrorHandler = (error: Error) => {
  if (error.message.includes('0x6511')) {
    return LEDGER_ERROR_CODES.NO_ETH_APP;
  }
  if (
    error.name.includes('BleError') ||
    error.message.includes('0x6b0c') ||
    error.message.includes('busy')
  ) {
    return LEDGER_ERROR_CODES.OFF_OR_LOCKED;
  }

  // used to logging any new errors so we can handle them properly, will likely remove pre-release
  logger.warn('[LedgerConnect] - Unknown Error', { error });
  forEach(Object.keys(error), key =>
    // @ts-ignore
    logger.debug('key: ', key, ' value: ', error[key])
  );

  return LEDGER_ERROR_CODES.UNKNOWN;
};

export const getEthApp = async (deviceId: string) => {
  const transport = await TransportBLE.open(deviceId);
  const eth = new AppEth(transport);
  return eth;
};

export const checkLedgerConnection = async ({
  deviceId,
  successCallback,
  errorCallback,
}: {
  deviceId: string;
  successCallback?: (deviceId: string) => void;
  errorCallback?: (errorType: LEDGER_ERROR_CODES) => void;
}) => {
  const transport = await TransportBLE.open(deviceId);
  const ethApp = new AppEth(transport);
  const path = getHdPath({ type: WalletLibraryType.ledger, index: 1 });
  ethApp
    .getAddress(path)
    .then(res => {
      logger.debug(
        '[checkLedgerConnection] - ledger is ready',
        {},
        DebugContext.ledger
      );
      successCallback?.(deviceId);
    })
    .catch(e => {
      const errorType = ledgerErrorHandler(e);
      logger.warn('[checkLedgerConnection] - ledger is not ready', {
        errorType: errorType,
        error: e,
      });
      errorCallback?.(errorType);
    });
};

export const getLedgerErrorText = (errorCode: LEDGER_ERROR_CODES) => {
  switch (errorCode) {
    case LEDGER_ERROR_CODES.OFF_OR_LOCKED:
      return i18n.t(i18n.l.hardware_wallets.errors.off_or_locked);
    case LEDGER_ERROR_CODES.NO_ETH_APP:
      return i18n.t(i18n.l.hardware_wallets.errors.no_eth_app);
    default:
      return i18n.t(i18n.l.hardware_wallets.errors.unknown);
  }
};
