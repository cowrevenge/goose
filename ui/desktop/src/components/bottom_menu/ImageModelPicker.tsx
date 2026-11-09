import { Check, ImageIcon, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { acpListImageModels, acpSwitchImageModel } from '../../acp/imageModels';
import { defineMessages, useIntl } from '../../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

const i18n = defineMessages({
  image: { id: 'imageModelPicker.image', defaultMessage: 'Image' },
  imageModel: { id: 'imageModelPicker.imageModel', defaultMessage: 'Image model' },
  switching: { id: 'imageModelPicker.switching', defaultMessage: 'Switching…' },
  restartHint: {
    id: 'imageModelPicker.restartHint',
    defaultMessage: 'Switching restarts the model server.',
  },
  failed: { id: 'imageModelPicker.failed', defaultMessage: 'Could not switch the image model' },
});

/** "qwen-image-2.1-turbo-F16" -> "turbo-F16": the part that differs between the models. */
export function shortImageModelName(name: string): string {
  return name.replace(/^qwen-image-[\d.]+-/i, '');
}

interface ImageModelPickerProps {
  isLoading: boolean;
}

/**
 * The image model picker in the chat bar, next to the thinking picker. It switches through the
 * same switcher as the tray's Image menu and the agent's image_model tool, so all three agree.
 * Hidden when there is no switcher or no image model.
 */
export function ImageModelPicker({ isLoading }: ImageModelPickerProps) {
  const intl = useIntl();
  const [current, setCurrent] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await acpListImageModels();
      if (list.error) {
        setModels([]);
        return;
      }
      setCurrent(list.current);
      setModels(list.models);
    } catch {
      // Keep what is shown; the next refresh tries again.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The agent can switch too (image_model, generate_image's model), so look again after each turn.
  useEffect(() => {
    if (!isLoading) void refresh();
  }, [isLoading, refresh]);

  const pick = async (model: string) => {
    if (model === current || switching) return;
    setSwitching(model);
    setError(null);
    try {
      await acpSwitchImageModel(model);
      setCurrent(model);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : intl.formatMessage(i18n.failed));
    } finally {
      setSwitching(null);
      void refresh();
    }
  };

  if (models.length === 0) return null;

  const label = switching
    ? intl.formatMessage(i18n.switching)
    : current
      ? shortImageModelName(current)
      : intl.formatMessage(i18n.image);

  return (
    <DropdownMenu onOpenChange={(open) => open && void refresh()}>
      <DropdownMenuTrigger
        data-testid="image-model-picker"
        className="flex items-center hover:cursor-pointer text-text-primary/70 hover:text-text-primary transition-colors"
        title={error ?? intl.formatMessage(i18n.imageModel)}
      >
        {switching ? (
          <LoaderCircle className="mr-1 h-4 w-4 flex-shrink-0 animate-spin" />
        ) : (
          <ImageIcon className="mr-1 h-4 w-4 flex-shrink-0" />
        )}
        <span className={error ? 'text-xs text-red-500' : 'text-xs'}>{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" className="w-64 text-sm">
        <h6 className="text-xs text-text-primary mt-2 ml-2">
          {intl.formatMessage(i18n.imageModel)}
        </h6>
        {models.map((model) => (
          <DropdownMenuItem
            key={model}
            data-testid={`image-model-${model}`}
            disabled={switching !== null}
            onSelect={() => void pick(model)}
          >
            <span className="truncate">{model}</span>
            {model === current && <Check className="ml-auto h-4 w-4" />}
          </DropdownMenuItem>
        ))}
        <p className="px-2 pb-2 pt-1 text-xs text-text-secondary">
          {error ?? intl.formatMessage(i18n.restartHint)}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
