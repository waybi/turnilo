/*
 * Copyright 2017-2019 Allegro.pl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as React from "react";
import { classNames } from "../../utils/dom/dom";
import { BodyPortal } from "../body-portal/body-portal";
import { MarkdownNode } from "../markdown-node/markdown-node";
import "./hover-description.scss";

export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
}

export interface DescriptionBubbleProps {
  anchor: AnchorRect;
  description: string;
  title?: string;
}

interface Position {
  left: number;
  top: number;
}

interface DescriptionBubbleState {
  position: Position | null;
}

const WIDTH = 340;
const GAP = 4;
const MARGIN = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

// Below the anchor when it fits, otherwise above; always kept inside the window.
export function placeBelow(anchor: AnchorRect, height: number, viewport: { width: number, height: number }): Position {
  const below = anchor.bottom + GAP;
  const top = below + height <= viewport.height - MARGIN ? below : anchor.top - GAP - height;
  return {
    left: clamp(anchor.left, MARGIN, Math.max(MARGIN, viewport.width - WIDTH - MARGIN)),
    top: clamp(top, MARGIN, Math.max(MARGIN, viewport.height - height - MARGIN))
  };
}

/**
 * Floating card that shows a measure's markdown description next to a screen rectangle.
 * It is rendered hidden once to measure its height, then moved into place.
 */
export class DescriptionBubble extends React.Component<DescriptionBubbleProps, DescriptionBubbleState> {
  state: DescriptionBubbleState = { position: null };

  componentDidUpdate(prevProps: DescriptionBubbleProps) {
    if (prevProps.anchor !== this.props.anchor && this.state.position) this.setState({ position: null });
  }

  // BodyPortal renders its children one tick after mounting, so measure when the node attaches.
  private measure = (bubble: HTMLDivElement | null) => {
    if (!bubble || this.state.position) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    this.setState({ position: placeBelow(this.props.anchor, bubble.offsetHeight, viewport) });
  };

  render() {
    const { description, title } = this.props;
    const { position } = this.state;
    return <BodyPortal left={position ? position.left : 0} top={position ? position.top : 0} disablePointerEvents={true}>
      <div
        ref={this.measure}
        className={classNames("hover-description", { measuring: !position })}
        style={{ width: WIDTH }}>
        {title && <div className="hover-description-title">{title}</div>}
        <MarkdownNode markdown={description} />
      </div>
    </BodyPortal>;
  }
}
