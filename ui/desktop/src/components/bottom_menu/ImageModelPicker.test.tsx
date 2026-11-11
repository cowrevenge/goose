import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { ImageModelPicker, shortImageModelName } from './ImageModelPicker';

const mockList = vi.fn();
const mockSwitch = vi.fn();
vi.mock('../../acp/imageModels', () => ({
  acpListImageModels: (...args: unknown[]) => mockList(...args),
  acpSwitchImageModel: (...args: unknown[]) => mockSwitch(...args),
}));

const MODELS = ['qwen-image-2.1-turbo-F16', 'qwen-image-2.1-turbo-Q8_0'];

describe('ImageModelPicker', () => {
  beforeEach(() => {
    mockList.mockReset();
    mockSwitch.mockReset();
  });

  it('shortens the model name to the part that differs', () => {
    expect(shortImageModelName('qwen-image-2.1-turbo-F16')).toBe('turbo-F16');
  });

  it('shows the model in use and switches when another is picked', async () => {
    mockList.mockResolvedValue({ current: MODELS[0], models: MODELS, error: null });
    mockSwitch.mockResolvedValue(undefined);
    render(<ImageModelPicker isLoading={false} />, { wrapper: IntlTestWrapper });

    const trigger = await screen.findByTestId('image-model-picker');
    expect(trigger).toHaveTextContent('turbo-F16');

    await userEvent.click(trigger);
    await userEvent.click(await screen.findByTestId(`image-model-${MODELS[1]}`));

    await waitFor(() => expect(mockSwitch).toHaveBeenCalledWith(MODELS[1]));
  });

  it('shows a red X with the reason when the switcher does not answer', async () => {
    mockList.mockResolvedValue({ current: null, models: [], error: 'did not answer' });
    render(<ImageModelPicker isLoading={false} />, { wrapper: IntlTestWrapper });
    expect(await screen.findByTestId('image-model-unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('image-model-picker')).toHaveAttribute('title', 'did not answer');
  });
});
