import { getAcpClient } from './acpConnection';

export interface ImageModels {
  current: string | null;
  models: string[];
  /** Set when the switcher (StrataTray) could not be asked. */
  error: string | null;
}

/** The local image models and the one in use, from the same switcher as the tray's Image menu. */
export async function acpListImageModels(): Promise<ImageModels> {
  const client = await getAcpClient();
  const response = await client.goose.imageModels_unstable({});
  return {
    current: response.current ?? null,
    models: response.models ?? [],
    error: response.error ?? null,
  };
}

/** Puts `model` on the image server; resolves once the server is up on it again. */
export async function acpSwitchImageModel(model: string): Promise<void> {
  const client = await getAcpClient();
  await client.goose.imageSwitch_unstable({ model });
}
