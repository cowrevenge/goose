import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntlTestWrapper } from '../i18n/test-utils';
import ThinkingContent from './ThinkingContent';
import { StepsStartCollapsedContext } from './turnWorkContext';

describe('ThinkingContent', () => {
  it('opens while streaming outside a work section', () => {
    render(<ThinkingContent content="planning the query" isExpanded={true} />, {
      wrapper: IntlTestWrapper,
    });
    expect(screen.getByText('planning the query')).toBeInTheDocument();
  });

  it('stays collapsed inside a work section', () => {
    render(
      <StepsStartCollapsedContext.Provider value={true}>
        <ThinkingContent content="planning the query" isExpanded={true} />
      </StepsStartCollapsedContext.Provider>,
      { wrapper: IntlTestWrapper }
    );
    expect(screen.queryByText('planning the query')).not.toBeInTheDocument();
    expect(screen.getByText('Thinking')).toBeInTheDocument();
  });
});
