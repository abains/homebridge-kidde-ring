import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { KiddeRingPlatform } from './platform';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, KiddeRingPlatform);
};
