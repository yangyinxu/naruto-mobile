import {AppConfig} from '../config';
import {Collector, ResearchMode} from '../domain/types';
import {BilibiliBrowserCollector} from './bilibiliBrowserCollector';
import {DemoCollector} from './demoCollector';
import {ChromeConnectionService} from '../services/chromeConnection';

export const createCollector = (
  mode: ResearchMode,
  config: AppConfig,
  chromeConnection: ChromeConnectionService
): Collector => mode === 'demo'
  ? new DemoCollector()
  : new BilibiliBrowserCollector(config, chromeConnection);
