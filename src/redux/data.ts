import {
  StaticJsonRpcProvider,
  TransactionResponse,
} from '@ethersproject/providers';
import isValidDomain from 'is-valid-domain';
import { find, isEmpty, isNil, keys, mapValues, partition } from 'lodash';
import { MMKV } from 'react-native-mmkv';
import { Dispatch } from 'redux';
import { ThunkDispatch } from 'redux-thunk';
import { BooleanMap } from '../hooks/useCoinListEditOptions';
import { addCashUpdatePurchases } from './addCash';
import {
  cancelDebouncedUpdateGenericAssets,
  debouncedUpdateGenericAssets,
} from './helpers/debouncedUpdateGenericAssets';
import { decrementNonce, incrementNonce } from './nonceManager';
import { AppGetState, AppState } from './store';
import { uniqueTokensRefreshState } from './uniqueTokens';
import { uniswapUpdateLiquidityTokens } from './uniswapLiquidity';
import {
  AssetTypes,
  NativeCurrencyKeys,
  NewTransactionOrAddCashTransaction,
  ParsedAddressAsset,
  RainbowTransaction,
  TransactionStatus,
  TransactionTypes,
  ZerionAsset,
  ZerionTransaction,
} from '@/entities';
import appEvents from '@/handlers/appEvents';
import {
  getAccountAssetsData,
  getLocalPendingTransactions,
  getLocalTransactions,
  saveAccountAssetsData,
  saveAccountEmptyState,
  saveLocalPendingTransactions,
  saveLocalTransactions,
} from '@/handlers/localstorage/accountLocal';
import {
  getProviderForNetwork,
  isL2Network,
  web3Provider,
} from '@/handlers/web3';
import WalletTypes from '@/helpers/walletTypes';
import { Navigation } from '@/navigation';
import { triggerOnSwipeLayout } from '@/navigation/onNavigationStateChange';
import { Network } from '@/helpers/networkTypes';
import {
  parseAccountAssets,
  parseAsset,
  parseNewTransaction,
  parseTransactions,
} from '@/parsers';
import { setHiddenCoins } from '@/redux/editOptions';
import { ETH_ADDRESS, shitcoins } from '@/references';
import Routes from '@/navigation/routesNames';
import { pickBy } from '@/helpers/utilities';
import { ethereumUtils, isLowerCaseMatch } from '@/utils';
import logger from '@/utils/logger';
import {
  fetchWalletENSDataAfterRegistration,
  getPendingTransactionData,
  getTransactionFlashbotStatus,
  getTransactionReceiptStatus,
  getTransactionSocketStatus,
} from '@/handlers/transactions';
import { SwapType } from '@rainbow-me/swaps';

const storage = new MMKV();

/**
 * Adds new hidden coins for an address and updates key-value storage.
 *
 * @param coins New coin IDs.
 * @param dispatch The Redux dispatch.
 * @param address The address to hide coins for.
 */
function addHiddenCoins(
  coins: string[],
  dispatch: ThunkDispatch<AppState, unknown, never>,
  address: string
) {
  const storageKey = 'hidden-coins-obj-' + address;
  const storageEntity = storage.getString(storageKey);
  const list = Object.keys(storageEntity ? JSON.parse(storageEntity) : {});
  const newHiddenCoins = [
    ...list.filter((i: string) => !coins.includes(i)),
    ...coins,
  ].reduce((acc, curr) => {
    acc[curr] = true;
    return acc;
  }, {} as BooleanMap);
  dispatch(setHiddenCoins(newHiddenCoins));
  storage.set(storageKey, JSON.stringify(newHiddenCoins));
}

const BACKUP_SHEET_DELAY_MS = android ? 10000 : 3000;

let pendingTransactionsHandle: ReturnType<typeof setTimeout> | null = null;
const TXN_WATCHER_MAX_TRIES = 60;
const TXN_WATCHER_MAX_TRIES_LAYER_2 = 200;
const TXN_WATCHER_POLL_INTERVAL = 5000; // 5 seconds
const GENERIC_ASSETS_FALLBACK_TIMEOUT = 10000; // 10 seconds

// -- Constants --------------------------------------- //

const DATA_UPDATE_GENERIC_ASSETS = 'data/DATA_UPDATE_GENERIC_ASSETS';
const DATA_UPDATE_ETH_USD = 'data/DATA_UPDATE_ETH_USD';
const DATA_UPDATE_PORTFOLIOS = 'data/DATA_UPDATE_PORTFOLIOS';

export const DATA_LOAD_ACCOUNT_ASSETS_DATA_REQUEST =
  'data/DATA_LOAD_ACCOUNT_ASSETS_DATA_REQUEST';
export const DATA_LOAD_ACCOUNT_ASSETS_DATA_RECEIVED =
  'data/DATA_LOAD_ACCOUNT_ASSETS_DATA_RECEIVED';
const DATA_LOAD_ACCOUNT_ASSETS_DATA_SUCCESS =
  'data/DATA_LOAD_ACCOUNT_ASSETS_DATA_SUCCESS';
const DATA_LOAD_ACCOUNT_ASSETS_DATA_FAILURE =
  'data/DATA_LOAD_ACCOUNT_ASSETS_DATA_FAILURE';
export const DATA_LOAD_ACCOUNT_ASSETS_DATA_FINALIZED =
  'data/DATA_LOAD_ACCOUNT_ASSETS_DATA_FINALIZED';

const DATA_LOAD_TRANSACTIONS_REQUEST = 'data/DATA_LOAD_TRANSACTIONS_REQUEST';
const DATA_LOAD_TRANSACTIONS_SUCCESS = 'data/DATA_LOAD_TRANSACTIONS_SUCCESS';
const DATA_LOAD_TRANSACTIONS_FAILURE = 'data/DATA_LOAD_TRANSACTIONS_FAILURE';

const DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS =
  'data/DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS';

const DATA_UPDATE_REFETCH_SAVINGS = 'data/DATA_UPDATE_REFETCH_SAVINGS';

const DATA_CLEAR_STATE = 'data/DATA_CLEAR_STATE';

// -- Actions ---------------------------------------- //

/**
 * The state for the `data` reducer.
 */
export interface DataState {
  /**
   * Parsed asset information for assets belonging to this account.
   */
  accountAssetsData: {
    [uniqueId: string]: ParsedAddressAsset;
  };

  /**
   * The ETH price in USD.
   */
  ethUSDPrice: number | undefined | null;

  /**
   * Parsed asset information for generic loaded assets.
   */
  genericAssets: {
    [assetAddress: string]: ParsedAddressAsset;
  };

  /**
   * Whether or not assets are currently being loaded.
   */
  isLoadingAssets: boolean;

  /**
   * Whether or not transactions are currently being loaded.
   */
  isLoadingTransactions: boolean;

  /**
   * Pending transactions for this account.
   */
  pendingTransactions: RainbowTransaction[];

  /**
   * Zerion portfolio information keyed by account address.
   */
  portfolios: {
    [accountAddress: string]: ZerionPortfolio;
  };

  /**
   * Whether or not savings should be reset.
   */
  shouldRefetchSavings: boolean;

  /**
   * Transactions for this account.
   */
  transactions: RainbowTransaction[];
}

/**
 * An action for the `data` reducer.
 */
type DataAction =
  | DataUpdateRefetchSavingsAction
  | DataUpdateGenericAssetsAction
  | DataUpdatePortfoliosAction
  | DataUpdateEthUsdAction
  | DataLoadTransactionsRequestAction
  | DataLoadTransactionSuccessAction
  | DataLoadTransactionsFailureAction
  | DataLoadAccountAssetsDataRequestAction
  | DataLoadAccountAssetsDataReceivedAction
  | DataLoadAccountAssetsDataSuccessAction
  | DataLoadAccountAssetsDataFailureAction
  | DataLoadAccountAssetsDataFinalizedAction
  | DataUpdatePendingTransactionSuccessAction
  | DataClearStateAction;

/**
 * The action to change `shouldRefetchSavings`.
 */
interface DataUpdateRefetchSavingsAction {
  type: typeof DATA_UPDATE_REFETCH_SAVINGS;
  payload: boolean;
}

/**
 * The action to update `genericAssets`.
 */
export interface DataUpdateGenericAssetsAction {
  type: typeof DATA_UPDATE_GENERIC_ASSETS;
  payload: DataState['genericAssets'];
}

/**
 * The action to update `portfolios`.
 */
interface DataUpdatePortfoliosAction {
  type: typeof DATA_UPDATE_PORTFOLIOS;
  payload: DataState['portfolios'];
}

/**
 * The action to update `ethUSDPrice`.
 */
interface DataUpdateEthUsdAction {
  type: typeof DATA_UPDATE_ETH_USD;
  payload: number | undefined;
}

/**
 * The action to set `isLoadingTransactions` to `true`.
 */
interface DataLoadTransactionsRequestAction {
  type: typeof DATA_LOAD_TRANSACTIONS_REQUEST;
}

/**
 * The action used to update transactions and indicate that loading transactions
 * was successful.
 */
interface DataLoadTransactionSuccessAction {
  type: typeof DATA_LOAD_TRANSACTIONS_SUCCESS;
  payload: DataState['transactions'];
}

/**
 * The action used to indicate that loading a transaction failed.
 */
interface DataLoadTransactionsFailureAction {
  type: typeof DATA_LOAD_TRANSACTIONS_FAILURE;
}

/**
 * The action to set `isLoadingAssets` to `true`.
 */
interface DataLoadAccountAssetsDataRequestAction {
  type: typeof DATA_LOAD_ACCOUNT_ASSETS_DATA_REQUEST;
}

/**
 * The action to update `accountAssetsData` and indicate that data has been
 * received.
 */
interface DataLoadAccountAssetsDataReceivedAction {
  type: typeof DATA_LOAD_ACCOUNT_ASSETS_DATA_RECEIVED;
  payload: DataState['accountAssetsData'];
}

/**
 * The action to update `accountAssetsData` and indicate that loading was
 * successful.
 */
interface DataLoadAccountAssetsDataSuccessAction {
  type: typeof DATA_LOAD_ACCOUNT_ASSETS_DATA_SUCCESS;
  payload: DataState['accountAssetsData'];
}

/**
 * The action used to incidate that loading account asset data failed.
 */
interface DataLoadAccountAssetsDataFailureAction {
  type: typeof DATA_LOAD_ACCOUNT_ASSETS_DATA_FAILURE;
}

/**
 * The action used to incidate that loading *all* account assets is finished.
 */
export interface DataLoadAccountAssetsDataFinalizedAction {
  type: typeof DATA_LOAD_ACCOUNT_ASSETS_DATA_FINALIZED;
}

/**
 * The action used to indicate that transactions were added successfully,
 * with a payload including the entire new array for `transactions`.
 */
interface DataUpdatePendingTransactionSuccessAction {
  type: typeof DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS;
  payload: DataState['transactions'];
}

/**
 * The action used to clear the state while maintaining generic asset data.
 */
interface DataClearStateAction {
  type: typeof DATA_CLEAR_STATE;
}

// Zerion types:

/**
 * Data loaded from the Zerion API for a portfolio. See
 * https://docs.zerion.io/websockets/models#portfolio for details.
 */
interface ZerionPortfolio {
  arbitrum_assets_value: number;
  aurora_assets_value: number;
  avalanche_assets_value: number;
  ethereum_assets_value: number;
  fantom_assets_value: number;
  loopring_assets_value: number;
  nft_floor_price_value: number;
  nft_last_price_value: number;
  optimism_assets_value: number;
  solana_assets_value: number;
  xdai_assets_value: number;
  assets_value: number;
  deposited_value: number;
  borrowed_value: number;
  locked_value: number;
  staked_value: number;
  bsc_assets_value: number;
  polygon_assets_value: number;
  total_value: number;
  absolute_change_24h: number;
  relative_change_24h?: number;
}

/**
 * A message from the Zerion API indicating that assets were received.
 */
export interface AddressAssetsReceivedMessage {
  payload?: {
    assets?: {
      [id: string]: {
        asset: ZerionAsset;
      };
    };
  };
  meta?: MessageMeta;
}

/**
 * A message from the Zerion API indicating that portfolio data was received.
 */
export interface PortfolioReceivedMessage {
  payload?: {
    portfolio?: ZerionPortfolio;
  };
  meta?: MessageMeta;
}

/**
 * A message from the Zerion API indicating that transaction data was received.
 */
export interface TransactionsReceivedMessage {
  payload?: {
    transactions?: ZerionTransaction[];
  };
  meta?: MessageMeta;
}

/**
 * A message from the Zerion API indicating that asset data was received. Note,
 * an actual message directly from Zerion would only include `ZerionAsset`
 * as the value type in the `prices` map, but this message type is also used
 * when manually invoking `assetPricesReceived` with fallback values.
 */
export interface AssetPricesReceivedMessage {
  payload?: {
    prices?: {
      [id: string]: ZerionAsset;
    };
  };
  meta?: MessageMeta;
}

/**
 * A message from the Zerion API indicating that asset prices were changed.
 */
export interface AssetPricesChangedMessage {
  payload?: {
    prices?: ZerionAsset[];
  };
  meta?: MessageMeta & { asset_code?: string };
}

/**
 * Metadata for a message from the Zerion API.
 */
export interface MessageMeta {
  address?: string;
  currency?: string;
  status?: string;
  chain_id?: Network; // L2
}

/**
 * A message from the Zerion API.
 */
type DataMessage =
  | AddressAssetsReceivedMessage
  | PortfolioReceivedMessage
  | TransactionsReceivedMessage
  | AssetPricesReceivedMessage
  | AssetPricesChangedMessage;

// The success code used to determine if an incoming message is successful.
export const DISPERSION_SUCCESS_CODE = 'ok';

// Functions:

/**
 * Loads initial state from account local storage.
 */
export const dataLoadState = () => async (
  dispatch: ThunkDispatch<
    AppState,
    unknown,
    | DataLoadAccountAssetsDataRequestAction
    | DataLoadAccountAssetsDataSuccessAction
    | DataLoadAccountAssetsDataFailureAction
    | DataLoadTransactionSuccessAction
    | DataLoadTransactionsRequestAction
    | DataLoadTransactionsFailureAction
    | DataUpdatePendingTransactionSuccessAction
  >,
  getState: AppGetState
) => {
  const { accountAddress, network } = getState().settings;
  try {
    dispatch({ type: DATA_LOAD_ACCOUNT_ASSETS_DATA_REQUEST });
    const accountAssetsData = await getAccountAssetsData(
      accountAddress,
      network
    );

    const isCurrentAccountAddress =
      accountAddress === getState().settings.accountAddress;
    if (!isCurrentAccountAddress) return;

    if (!isEmpty(accountAssetsData)) {
      dispatch({
        payload: accountAssetsData,
        type: DATA_LOAD_ACCOUNT_ASSETS_DATA_SUCCESS,
      });
    }
  } catch (error) {
    dispatch({ type: DATA_LOAD_ACCOUNT_ASSETS_DATA_FAILURE });
  }
  try {
    dispatch({ type: DATA_LOAD_TRANSACTIONS_REQUEST });
    const transactions = await getLocalTransactions(accountAddress, network);
    const pendingTransactions = await getLocalPendingTransactions(
      accountAddress,
      network
    );
    const isCurrentAccountAddress =
      accountAddress === getState().settings.accountAddress;
    if (!isCurrentAccountAddress) return;

    dispatch({
      payload: pendingTransactions,
      type: DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS,
    });
    dispatch({
      payload: transactions,
      type: DATA_LOAD_TRANSACTIONS_SUCCESS,
    });
  } catch (error) {
    dispatch({ type: DATA_LOAD_TRANSACTIONS_FAILURE });
  }
};

/**
 * Resets state, with the exception of generic asset prices, and unsubscribes
 * from listeners and timeouts.
 */
export const dataResetState = () => (
  dispatch: Dispatch<DataClearStateAction>
) => {
  // cancel any debounced updates so we won't override any new data with stale debounced ones
  cancelDebouncedUpdateGenericAssets();

  pendingTransactionsHandle && clearTimeout(pendingTransactionsHandle);

  dispatch({ type: DATA_CLEAR_STATE });
};

/**
 * Updates account asset data in state for a specific asset and saves to account
 * local storage.
 *
 * @param assetData The updated asset, which replaces or adds to the current
 * account's asset data based on it's `uniqueId`.
 */
export const dataUpdateAsset = (assetData: ParsedAddressAsset) => (
  dispatch: Dispatch<DataLoadAccountAssetsDataSuccessAction>,
  getState: AppGetState
) => {
  const { accountAddress, network } = getState().settings;
  const { accountAssetsData } = getState().data;
  const updatedAssetsData = {
    ...accountAssetsData,
    [assetData.uniqueId]: assetData,
  };
  dispatch({
    payload: updatedAssetsData,
    type: DATA_LOAD_ACCOUNT_ASSETS_DATA_SUCCESS,
  });
  saveAccountAssetsData(updatedAssetsData, accountAddress, network);
};

/**
 * Checks whether or not metadata received from Zerion is valid.
 *
 * @param message The message received from Zerion.
 */
const checkMeta = (message: DataMessage | undefined) => (
  dispatch: Dispatch<never>,
  getState: AppGetState
) => {
  const { accountAddress, nativeCurrency } = getState().settings;
  const address = message?.meta?.address;
  const currency = message?.meta?.currency;
  return (
    isLowerCaseMatch(address!, accountAddress) &&
    isLowerCaseMatch(currency!, nativeCurrency)
  );
};

/**
 * Checks to see if new savings are available based on incoming transaction data,
 * and if so, updates state to request refetching savings.
 *
 * @param transactionsData Incoming transaction data.
 */
const checkForConfirmedSavingsActions = (
  transactionsData: ZerionTransaction[]
) => (dispatch: ThunkDispatch<AppState, unknown, never>) => {
  const foundConfirmedSavings = find(
    transactionsData,
    (transaction: ZerionTransaction) =>
      (transaction?.type === 'deposit' || transaction?.type === 'withdraw') &&
      transaction?.status === 'confirmed'
  );
  if (foundConfirmedSavings) {
    dispatch(updateRefetchSavings(true));
  }
};

/**
 * Checks to see if a network's nonce should be incremented for an acount
 * based on incoming transaction data, and if so, updates state.
 *
 * @param transactionData Incoming transaction data.
 */
const checkForUpdatedNonce = (transactionData: ZerionTransaction[]) => (
  dispatch: ThunkDispatch<AppState, unknown, never>,
  getState: AppGetState
) => {
  if (transactionData.length) {
    const { accountAddress, network } = getState().settings;
    const txSortedByDescendingNonce = transactionData
      .filter(tx => {
        const addressFrom = tx?.address_from;
        return (
          addressFrom &&
          addressFrom.toLowerCase() === accountAddress.toLowerCase()
        );
      })
      .sort(({ nonce: n1 }, { nonce: n2 }) => (n2 ?? 0) - (n1 ?? 0));
    const [latestTx] = txSortedByDescendingNonce;
    const addressFrom = latestTx?.address_from;
    const nonce = latestTx?.nonce;
    if (addressFrom && nonce) {
      // @ts-ignore-next-line
      dispatch(incrementNonce(addressFrom!, nonce, network));
    }
  }
};

/**
 * Handles an incoming portfolio data message from Zerion and updates state
 * accordidngly.
 *
 * @param message The `PortfolioReceivedMessage`, or undefined.
 */
export const portfolioReceived = (
  message: PortfolioReceivedMessage | undefined
) => async (
  dispatch: Dispatch<DataUpdatePortfoliosAction>,
  getState: AppGetState
) => {
  if (message?.meta?.status !== DISPERSION_SUCCESS_CODE) return;
  if (!message?.payload?.portfolio) return;

  const { portfolios } = getState().data;

  const newPortfolios = { ...portfolios };
  newPortfolios[message.meta.address!] = message.payload.portfolio;

  dispatch({
    payload: newPortfolios,
    type: DATA_UPDATE_PORTFOLIOS,
  });
};

/**
 * Handles a `TransactionsReceivedMessage` message from Zerion and updates
 * state and account local storage accordingly.
 *
 * @param message The `TransactionsReceivedMessage`, or undefined.
 * @param appended Whether or not transactions are being appended.
 */
export const transactionsReceived = (
  message: TransactionsReceivedMessage | undefined,
  appended = false
) => async (
  dispatch: ThunkDispatch<
    AppState,
    unknown,
    DataLoadTransactionSuccessAction | DataUpdatePendingTransactionSuccessAction
  >,
  getState: AppGetState
) => {
  const isValidMeta = dispatch(checkMeta(message));
  if (!isValidMeta) return;
  const transactionData = message?.payload?.transactions ?? [];
  if (appended) {
    dispatch(checkForConfirmedSavingsActions(transactionData));
  }

  const { network } = getState().settings;
  let currentNetwork = network;
  if (currentNetwork === Network.mainnet && message?.meta?.chain_id) {
    currentNetwork = message?.meta?.chain_id;
  }
  if (transactionData.length && currentNetwork === Network.mainnet) {
    dispatch(checkForUpdatedNonce(transactionData));
  }

  const { accountAddress, nativeCurrency } = getState().settings;
  const { purchaseTransactions } = getState().addCash;
  const { pendingTransactions, transactions } = getState().data;
  const { selected } = getState().wallets;

  const {
    parsedTransactions,
    potentialNftTransaction,
  } = await parseTransactions(
    transactionData,
    accountAddress,
    nativeCurrency,
    transactions,
    pendingTransactions,
    purchaseTransactions,
    currentNetwork,
    appended
  );

  const isCurrentAccountAddress =
    accountAddress === getState().settings.accountAddress;
  if (!isCurrentAccountAddress) return;

  if (appended && potentialNftTransaction) {
    setTimeout(() => {
      dispatch(uniqueTokensRefreshState());
    }, 60000);
  }
  const txHashes = parsedTransactions.map(tx => ethereumUtils.getHash(tx));
  const updatedPendingTransactions = pendingTransactions.filter(
    tx => !txHashes.includes(ethereumUtils.getHash(tx))
  );

  dispatch({
    payload: updatedPendingTransactions,
    type: DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS,
  });
  dispatch({
    payload: parsedTransactions,
    type: DATA_LOAD_TRANSACTIONS_SUCCESS,
  });
  dispatch(updatePurchases(parsedTransactions));
  saveLocalTransactions(parsedTransactions, accountAddress, network);
  saveLocalPendingTransactions(
    updatedPendingTransactions,
    accountAddress,
    network
  );

  if (appended && parsedTransactions.length) {
    if (
      selected &&
      !selected.backedUp &&
      !selected.imported &&
      selected.type !== WalletTypes.readOnly
    ) {
      setTimeout(() => {
        triggerOnSwipeLayout(() =>
          Navigation.handleAction(Routes.BACKUP_SHEET, { single: true })
        );
      }, BACKUP_SHEET_DELAY_MS);
    }
  }
};

/**
 * Handles an `AddressAssetsReceivedMessage` from Zerion and updates state and
 * account local storage.
 *
 * @param message The message.
 * @param assetsNetwork The asset's network.
 */
export const addressAssetsReceived = (
  message: AddressAssetsReceivedMessage,
  assetsNetwork: Network | null = null
) => (
  dispatch: ThunkDispatch<
    AppState,
    unknown,
    DataLoadAccountAssetsDataReceivedAction
  >,
  getState: AppGetState
) => {
  const isValidMeta = dispatch(checkMeta(message));
  if (!isValidMeta) return;
  const { accountAddress, network } = getState().settings;
  const responseAddress = message?.meta?.address;
  const addressMatch =
    accountAddress?.toLowerCase() === responseAddress?.toLowerCase();
  if (!addressMatch) return;

  const newAssets = message?.payload?.assets ?? {};
  let updatedAssets = pickBy(
    newAssets,
    asset =>
      asset?.asset?.type !== AssetTypes.compound &&
      asset?.asset?.type !== AssetTypes.trash &&
      !shitcoins.includes(asset?.asset?.asset_code?.toLowerCase())
  );

  let parsedAssets = parseAccountAssets(updatedAssets) as {
    [id: string]: ParsedAddressAsset;
  };

  const liquidityTokens = Object.values(parsedAssets).filter(
    asset => asset?.type === AssetTypes.uniswapV2
  );

  // remove V2 LP tokens
  parsedAssets = pickBy(
    parsedAssets,
    asset => asset?.type !== AssetTypes.uniswapV2
  );

  const isL2 = assetsNetwork && isL2Network(assetsNetwork);
  if (!isL2 && !assetsNetwork) {
    dispatch(uniswapUpdateLiquidityTokens(liquidityTokens));
  }

  const { accountAssetsData: existingAccountAssetsData } = getState().data;

  if (!assetsNetwork) {
    const existingL2DataOnly = pickBy(
      existingAccountAssetsData,
      (value: ParsedAddressAsset, index: string) => {
        return index.includes('_');
      }
    );
    parsedAssets = {
      ...existingL2DataOnly,
      ...parsedAssets,
    };
  } else {
    parsedAssets = {
      ...existingAccountAssetsData,
      ...parsedAssets,
    };
  }

  parsedAssets = pickBy(
    parsedAssets,
    asset => !!Number(asset?.balance?.amount)
  );

  saveAccountAssetsData(parsedAssets, accountAddress, network);
  if (!isEmpty(parsedAssets)) {
    // Change the state since the account isn't empty anymore
    saveAccountEmptyState(false, accountAddress, network);
  }

  const assetsWithScamURL: string[] = Object.values(parsedAssets)
    .filter(
      asset =>
        ((asset?.name && isValidDomain(asset?.name.replaceAll(' ', ''))) ||
          (asset?.symbol && isValidDomain(asset.symbol))) &&
        !asset.isVerified
    )
    .map(asset => asset.uniqueId);

  // we need to store hidden coins before storing parsedAssets
  // so all the selectors that depend on both will have hidden coins by that time
  // to be able to filter them
  addHiddenCoins(assetsWithScamURL, dispatch, accountAddress);

  dispatch({
    payload: parsedAssets,
    type: DATA_LOAD_ACCOUNT_ASSETS_DATA_RECEIVED,
  });
};

const callbacksOnAssetReceived: {
  [address: string]: ((asset: ParsedAddressAsset) => unknown) | undefined;
} = {};

/**
 * Saves a callback function to be called when an asset's price is loaded.
 *
 * @param address The asset's address.
 * @param action The callback.
 */
export function scheduleActionOnAssetReceived(
  address: string,
  action: (asset: ParsedAddressAsset) => unknown
) {
  callbacksOnAssetReceived[address.toLowerCase()] = action;
}

/**
 * Handles a `AssetPricesReceivedMessage` from Zerion and updates state.
 *
 * @param message The message, or undefined.
 */
export const assetPricesReceived = (
  message: AssetPricesReceivedMessage | undefined
) => (
  dispatch: Dispatch<DataUpdateGenericAssetsAction | DataUpdateEthUsdAction>,
  getState: AppGetState
) => {
  const newAssetPrices = message?.payload?.prices ?? {};
  const { nativeCurrency } = getState().settings;

  if (nativeCurrency.toLowerCase() === message?.meta?.currency) {
    if (isEmpty(newAssetPrices)) return;
    const parsedAssets = mapValues(newAssetPrices, asset =>
      parseAsset(asset)
    ) as {
      [id: string]: ParsedAddressAsset;
    };
    const { genericAssets } = getState().data;

    const updatedAssets = {
      ...genericAssets,
      ...parsedAssets,
    };

    const assetAddresses = Object.keys(parsedAssets);

    for (const address of assetAddresses) {
      callbacksOnAssetReceived[address.toLowerCase()]?.(parsedAssets[address]);
      callbacksOnAssetReceived[address.toLowerCase()] = undefined;
    }

    dispatch({
      payload: updatedAssets,
      type: DATA_UPDATE_GENERIC_ASSETS,
    });
  }
  if (
    message?.meta?.currency?.toLowerCase() ===
      NativeCurrencyKeys.USD.toLowerCase() &&
    newAssetPrices[ETH_ADDRESS]
  ) {
    const value = newAssetPrices[ETH_ADDRESS]?.price?.value;
    dispatch({
      payload: value,
      type: DATA_UPDATE_ETH_USD,
    });
  }
};

/**
 * Handles a `AssetPricesChangedMessage` from Zerion and updates state.
 *
 * @param message The message.
 */
export const assetPricesChanged = (
  message: AssetPricesChangedMessage | undefined
) => (
  dispatch: Dispatch<DataUpdateGenericAssetsAction | DataUpdateEthUsdAction>,
  getState: AppGetState
) => {
  const { nativeCurrency } = getState().settings;

  const price = message?.payload?.prices?.[0]?.price;
  const assetAddress = message?.meta?.asset_code;
  if (isNil(price) || isNil(assetAddress)) return;

  if (nativeCurrency?.toLowerCase() === message?.meta?.currency) {
    const { genericAssets } = getState().data;
    const genericAsset = {
      ...genericAssets?.[assetAddress],
      price,
    };
    const updatedAssets = {
      ...genericAssets,
      [assetAddress]: genericAsset,
    } as {
      [address: string]: ParsedAddressAsset;
    };

    debouncedUpdateGenericAssets(
      {
        payload: updatedAssets,
        type: DATA_UPDATE_GENERIC_ASSETS,
      },
      dispatch
    );
  }
  if (
    message?.meta?.currency?.toLowerCase() ===
      NativeCurrencyKeys.USD.toLowerCase() &&
    assetAddress === ETH_ADDRESS
  ) {
    dispatch({
      payload: price?.value,
      type: DATA_UPDATE_ETH_USD,
    });
  }
};

/**
 * Updates state and account local storage with a new transaction.
 *
 * @param txDetails The transaction details to parse.
 * @param accountAddressToUpdate The account to add the transaction to, or null
 * to default to the currently selected account.
 * @param disableTxnWatcher Whether or not to disable the pending transaction
 * watcher.
 * @param provider A `StaticJsonRpcProvider` to use for watching the pending
 * transaction, or null to use the default provider.
 */
export const dataAddNewTransaction = (
  txDetails: NewTransactionOrAddCashTransaction,
  accountAddressToUpdate: string | null = null,
  disableTxnWatcher = false,
  provider: StaticJsonRpcProvider | null = null
) => async (
  dispatch: ThunkDispatch<
    AppState,
    unknown,
    DataUpdatePendingTransactionSuccessAction
  >,
  getState: AppGetState
) => {
  const { pendingTransactions } = getState().data;
  const { accountAddress, nativeCurrency, network } = getState().settings;
  if (
    accountAddressToUpdate &&
    accountAddressToUpdate.toLowerCase() !== accountAddress.toLowerCase()
  )
    return;
  try {
    const parsedTransaction = await parseNewTransaction(
      txDetails,
      nativeCurrency
    );
    const _pendingTransactions = [parsedTransaction, ...pendingTransactions];
    dispatch({
      payload: _pendingTransactions,
      type: DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS,
    });
    saveLocalPendingTransactions(_pendingTransactions, accountAddress, network);
    if (parsedTransaction.from && parsedTransaction.nonce) {
      dispatch(
        // @ts-ignore-next-line
        incrementNonce(
          parsedTransaction.from,
          parsedTransaction.nonce,
          parsedTransaction.network
        )
      );
    }
    if (
      !disableTxnWatcher ||
      network !== Network.mainnet ||
      parsedTransaction?.network
    ) {
      dispatch(
        watchPendingTransactions(
          accountAddress,
          parsedTransaction.network
            ? TXN_WATCHER_MAX_TRIES_LAYER_2
            : TXN_WATCHER_MAX_TRIES,
          null,
          // @ts-expect-error `watchPendingTransactions` only takes 3 arguments.
          provider
        )
      );
    }
    return parsedTransaction;
    // eslint-disable-next-line no-empty
  } catch (error) {}
};

/**
 * Watches pending transactions and updates state and account local storage
 * when new data is available.
 *
 * @param provider A `StaticJsonRpcProvider`, or null to use the default
 * provider.
 * @param currentNonce The nonce of the last confirmed transaction, used to
 * determine if a transaction has been dropped.
 */
export const dataWatchPendingTransactions = (
  provider: StaticJsonRpcProvider | null = null,
  currentNonce = -1
) => async (
  dispatch: ThunkDispatch<
    AppState,
    unknown,
    DataLoadTransactionSuccessAction | DataUpdatePendingTransactionSuccessAction
  >,
  getState: AppGetState
) => {
  const { pendingTransactions: pending } = getState().data;
  if (isEmpty(pending)) {
    return true;
  }
  let txStatusesDidChange = false;
  const updatedPendingTransactions = await Promise.all(
    pending.map(async tx => {
      const updatedPendingTransaction: RainbowTransaction = { ...tx };
      const txHash = ethereumUtils.getHash(tx) || '';
      let pendingTransactionData: {
        title: string;
        minedAt: number | null;
        pending: boolean;
        status: TransactionStatus;
      } | null = {
        status: TransactionStatus.sending,
        title: tx?.title || TransactionStatus.sending,
        minedAt: null,
        pending: true,
      };
      try {
        logger.log('Checking pending tx with hash', txHash);
        const p =
          (await getProviderForNetwork(updatedPendingTransaction.network)) ||
          provider;
        const txObj: TransactionResponse | undefined = await p.getTransaction(
          txHash
        );
        // if the nonce of last confirmed tx is higher than this pending tx then it got dropped
        const nonceAlreadyIncluded = currentNonce > (tx?.nonce ?? txObj.nonce);
        if (
          (txObj && txObj?.blockNumber && txObj?.blockHash) ||
          nonceAlreadyIncluded
        ) {
          // When speeding up a non "normal tx" we need to resubscribe
          // because zerion "append" event isn't reliable
          logger.log('TX CONFIRMED!', txObj);
          if (!nonceAlreadyIncluded) {
            appEvents.emit('transactionConfirmed', {
              ...txObj,
              internalType: tx.type,
            });
          }
          if (tx?.ensRegistration) {
            fetchWalletENSDataAfterRegistration();
          }
          const transactionStatus = await getTransactionReceiptStatus(
            updatedPendingTransaction,
            nonceAlreadyIncluded,
            txObj
          );

          // approvals are not via socket so we dont want to check their status with them.
          const isApproveTx =
            transactionStatus === TransactionStatus.approved ||
            transactionStatus === TransactionStatus.approving;
          if (
            updatedPendingTransaction?.swap?.type === SwapType.crossChain &&
            !isApproveTx
          ) {
            pendingTransactionData = await getTransactionSocketStatus(
              updatedPendingTransaction
            );
            if (!pendingTransactionData.pending) {
              appEvents.emit('transactionConfirmed', {
                ...txObj,
                internalType: tx.type,
              });
              txStatusesDidChange = true;
            }
          } else {
            pendingTransactionData = getPendingTransactionData(
              updatedPendingTransaction,
              transactionStatus
            );
            txStatusesDidChange = true;
          }
        } else if (tx.flashbots) {
          pendingTransactionData = await getTransactionFlashbotStatus(
            updatedPendingTransaction,
            txHash
          );
          if (pendingTransactionData && !pendingTransactionData.pending) {
            txStatusesDidChange = true;
            // decrement the nonce since it was dropped
            // @ts-ignore-next-line
            dispatch(decrementNonce(tx.from!, tx.nonce!, Network.mainnet));
          }
        }
        if (pendingTransactionData) {
          updatedPendingTransaction.title = pendingTransactionData.title;
          updatedPendingTransaction.status = pendingTransactionData.status;
          updatedPendingTransaction.pending = pendingTransactionData.pending;
          updatedPendingTransaction.minedAt = pendingTransactionData.minedAt;
        }
      } catch (error) {
        logger.log('Error watching pending txn', error);
      }
      return updatedPendingTransaction;
    })
  );

  if (txStatusesDidChange) {
    const { accountAddress, network } = getState().settings;
    const [newDataTransactions, pendingTransactions] = partition(
      updatedPendingTransactions.filter(
        ({ status }) => status !== TransactionStatus.unknown
      ),
      tx => !tx.pending
    );
    dispatch({
      payload: pendingTransactions,
      type: DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS,
    });
    saveLocalPendingTransactions(pendingTransactions, accountAddress, network);

    const { transactions } = getState().data;
    const updatedTransactions = newDataTransactions.concat(transactions);
    dispatch({
      payload: updatedTransactions,
      type: DATA_LOAD_TRANSACTIONS_SUCCESS,
    });
    saveLocalTransactions(updatedTransactions, accountAddress, network);
    dispatch(updatePurchases(updatedTransactions));
    if (!pendingTransactions?.length) {
      return true;
    }
  }
  return false;
};

/**
 * Updates a transaction in state and account local storage and watches it,
 * if `watch` is true.
 *
 * @param txHash The transaction hash to update.
 * @param txObj The updated transaction data.
 * @param watch Whether or not to watch the new transaction.
 * @param provider A `StaticJsonRpcProvider`, or null to use the default
 * provider.
 */
export const dataUpdateTransaction = (
  txHash: string,
  txObj: RainbowTransaction,
  watch: boolean,
  provider: StaticJsonRpcProvider | null = null
) => async (
  dispatch: ThunkDispatch<
    AppState,
    unknown,
    DataUpdatePendingTransactionSuccessAction
  >,
  getState: AppGetState
) => {
  const { pendingTransactions } = getState().data;

  const allOtherTx = pendingTransactions.filter(tx => tx.hash !== txHash);
  const updatedTransactions = [txObj].concat(allOtherTx);

  dispatch({
    payload: updatedTransactions,
    type: DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS,
  });
  const { accountAddress, network } = getState().settings;
  saveLocalPendingTransactions(updatedTransactions, accountAddress, network);
  // Always watch cancellation and speed up
  if (watch) {
    dispatch(
      watchPendingTransactions(
        accountAddress,
        txObj.network ? TXN_WATCHER_MAX_TRIES_LAYER_2 : TXN_WATCHER_MAX_TRIES,
        provider
      )
    );
  }
};

/**
 * Updates purchases using the `addCash` reducer to reflect new transaction data.
 * Called when new transaction information is loaded.
 *
 * @param updatedTransactions The array of updated transactions.
 */
const updatePurchases = (updatedTransactions: RainbowTransaction[]) => (
  dispatch: ThunkDispatch<AppState, unknown, never>
) => {
  const confirmedPurchases = updatedTransactions.filter(txn => {
    return (
      txn.type === TransactionTypes.purchase &&
      txn.status !== TransactionStatus.purchasing
    );
  });
  dispatch(addCashUpdatePurchases(confirmedPurchases));
};

/**
 * Checks the current account's transaction count and subscribes to pending
 * transaction updates using `dataWatchPendingTransactions`.
 *
 * @param accountAddressToWatch The address to watch. If this does not match
 * the currently selected address, the subscription is not started.
 * @param provider A `StaticJsonRpcProvider`, or null to use the default
 * provider.
 */
export const checkPendingTransactionsOnInitialize = (
  accountAddressToWatch: string,
  provider: StaticJsonRpcProvider | null = null
) => async (
  dispatch: ThunkDispatch<AppState, unknown, never>,
  getState: AppGetState
) => {
  const { accountAddress: currentAccountAddress } = getState().settings;
  if (currentAccountAddress !== accountAddressToWatch) return;
  const currentNonce = await (provider || web3Provider).getTransactionCount(
    currentAccountAddress,
    'latest'
  );
  const notPendingTxs = await dispatch(
    dataWatchPendingTransactions(provider, currentNonce)
  );
  if (!notPendingTxs) {
    dispatch(
      watchPendingTransactions(
        currentAccountAddress,
        TXN_WATCHER_MAX_TRIES,
        null
      )
    );
  }
};

/**
 * Repeatedly attempts to subscribe to transaction updates using
 * `dataWatchPendingTransactions` until there are no more pending transactions
 * or `remainingTries` attempts are exhausted.
 *
 * @param accountAddressToWatch The account address to watch. If this does
 * not match the currently selected address, the subscription is not started.
 * @param remainingTries The remaining number of attempts.
 * @param provider A `StaticJsonRpcProvider`, or null to use the default
 * provider.
 */
export const watchPendingTransactions = (
  accountAddressToWatch: string,
  remainingTries: number = TXN_WATCHER_MAX_TRIES,
  provider: StaticJsonRpcProvider | null = null
) => async (
  dispatch: ThunkDispatch<AppState, unknown, never>,
  getState: AppGetState
) => {
  pendingTransactionsHandle && clearTimeout(pendingTransactionsHandle);
  if (remainingTries === 0) return;

  const { accountAddress: currentAccountAddress } = getState().settings;
  if (currentAccountAddress !== accountAddressToWatch) return;

  const done = await dispatch(dataWatchPendingTransactions(provider));

  if (!done) {
    pendingTransactionsHandle = setTimeout(() => {
      dispatch(
        watchPendingTransactions(
          accountAddressToWatch,
          remainingTries - 1,
          provider
        )
      );
    }, TXN_WATCHER_POLL_INTERVAL);
  }
};

/**
 * Updates state to indicate whether or not savings data should be refetched.
 *
 * @param fetch Whether or not savings should be refetched.
 */
export const updateRefetchSavings = (fetch: boolean) => (
  dispatch: Dispatch<DataUpdateRefetchSavingsAction>
) =>
  dispatch({
    payload: fetch,
    type: DATA_UPDATE_REFETCH_SAVINGS,
  });

// -- Reducer ----------------------------------------- //
const INITIAL_STATE: DataState = {
  accountAssetsData: {}, // for account-specific assets
  ethUSDPrice: null,
  genericAssets: {},
  isLoadingAssets: true,
  isLoadingTransactions: true,
  pendingTransactions: [],
  portfolios: {},
  shouldRefetchSavings: false,
  transactions: [],
};

export default (state: DataState = INITIAL_STATE, action: DataAction) => {
  switch (action.type) {
    case DATA_UPDATE_REFETCH_SAVINGS:
      return { ...state, shouldRefetchSavings: action.payload };
    case DATA_UPDATE_GENERIC_ASSETS:
      return { ...state, genericAssets: action.payload };
    case DATA_UPDATE_PORTFOLIOS:
      return {
        ...state,
        portfolios: action.payload,
      };
    case DATA_UPDATE_ETH_USD:
      return {
        ...state,
        ethUSDPrice: action.payload,
      };
    case DATA_LOAD_TRANSACTIONS_REQUEST:
      return {
        ...state,
        isLoadingTransactions: true,
      };
    case DATA_LOAD_TRANSACTIONS_SUCCESS:
      return {
        ...state,
        isLoadingTransactions: false,
        transactions: action.payload,
      };
    case DATA_LOAD_TRANSACTIONS_FAILURE:
      return {
        ...state,
        isLoadingTransactions: false,
      };
    case DATA_LOAD_ACCOUNT_ASSETS_DATA_REQUEST:
      return {
        ...state,
        isLoadingAssets: true,
      };
    case DATA_LOAD_ACCOUNT_ASSETS_DATA_RECEIVED: {
      return {
        ...state,
        accountAssetsData: action.payload,
      };
    }
    case DATA_LOAD_ACCOUNT_ASSETS_DATA_SUCCESS: {
      return {
        ...state,
        accountAssetsData: action.payload,
        isLoadingAssets: false,
      };
    }
    case DATA_LOAD_ACCOUNT_ASSETS_DATA_FAILURE:
      return {
        ...state,
        isLoadingAssets: false,
      };
    case DATA_LOAD_ACCOUNT_ASSETS_DATA_FINALIZED: {
      return {
        ...state,
        isLoadingAssets: false,
      };
    }
    case DATA_UPDATE_PENDING_TRANSACTIONS_SUCCESS:
      return {
        ...state,
        pendingTransactions: action.payload,
      };
    case DATA_CLEAR_STATE:
      return {
        ...state,
        ...INITIAL_STATE,
        genericAssets: state.genericAssets,
      };
    default:
      return state;
  }
};
