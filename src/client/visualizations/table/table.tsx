/*
 * Copyright 2015-2016 Imply Data, Inc.
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

import * as d3 from "d3";
import { Dataset, Datum, FlattenOptions, PseudoDatum } from "plywood";
import * as React from "react";
import { Essence, VisStrategy } from "../../../common/models/essence/essence";
import { SeriesDerivation } from "../../../common/models/series/concrete-series";
import { Series } from "../../../common/models/series/series";
import { SeriesSort, SortDirection } from "../../../common/models/sort/sort";
import { ImmutableRecord } from "../../../common/utils/immutable-utils/immutable-utils";
import { TableSettings } from "../../../common/visualization-manifests/table/settings";
import { TABLE_MANIFEST } from "../../../common/visualization-manifests/table/table";
import { HighlightModal } from "../../components/highlight-modal/highlight-modal";
import { AnchorRect, DescriptionBubble } from "../../components/hover-description/hover-description";
import { Direction, ResizeHandle } from "../../components/resize-handle/resize-handle";
import { Scroller, ScrollerLayout, ScrollerPart } from "../../components/scroller/scroller";
import { BaseVisualization, BaseVisualizationState } from "../base-visualization/base-visualization";
import { MeasureRows } from "./body/measures/measure-rows";
import { nestedSplitName } from "./body/splits/nested-split-name";
import { SplitRows } from "./body/splits/split-rows";
import { MeasuresHeader } from "./header/measures/measures-header";
import { SplitsHeader } from "./header/splits/splits-header";
import { Highlighter } from "./highlight/highlight";
import "./table.scss";
import { HoverElement, PositionHover, rowPosition, seriesPosition } from "./utils/calculate-hover-position";
import { getFilterFromDatum } from "./utils/filter-for-datum";
import { measureColumnsCount } from "./utils/measure-columns-count";
import { visibleIndexRange } from "./utils/visible-index-range";

export const HEADER_HEIGHT = 38;
export const INDENT_WIDTH = 25;
export const ROW_HEIGHT = 30;
export const SPACE_LEFT = 10;

const HIGHLIGHT_BUBBLE_V_OFFSET = -4;
const SEGMENT_WIDTH = 300;
const MEASURE_WIDTH = 130;
const SPACE_RIGHT = 10;
const MIN_DIMENSION_WIDTH = 100;
const HEADER_HOVER_DELAY = 250;

interface HeaderHover {
  column: number;
  title: string;
  description: string;
  anchor: AnchorRect;
}

export interface TableState extends BaseVisualizationState {
  flatData?: PseudoDatum[];
  hoverRow?: Datum;
  segmentWidth: number;
  headerHover?: HeaderHover;
}

export class Table extends BaseVisualization<TableState> {
  protected className = TABLE_MANIFEST.name;
  protected innerTableRef = React.createRef<HTMLDivElement>();
  private headerHoverTimer: number = null;
  private pendingHeaderColumn: number = null;

  getDefaultState(): TableState {
    return {
      flatData: null,
      hoverRow: null,
      headerHover: null,
      segmentWidth: SEGMENT_WIDTH,
      ...super.getDefaultState()
    };
  }

  private getIdealColumnWidth(): number {
    const availableWidth = this.props.stage.width - SPACE_LEFT - this.getSegmentWidth();
    const count = measureColumnsCount(this.props.essence);

    return count * MEASURE_WIDTH >= availableWidth ? MEASURE_WIDTH : availableWidth / count;
  }

  maxSegmentWidth(): number {
    if (this.innerTableRef.current) {
      return this.innerTableRef.current.clientWidth - MIN_DIMENSION_WIDTH;
    }

    return SEGMENT_WIDTH;
  }

  getSegmentWidth(): number {
    const { segmentWidth } = this.state;
    return segmentWidth || SEGMENT_WIDTH;
  }

  private setSortToSeries(series: Series, period: SeriesDerivation) {
    const { clicker, essence } = this.props;
    const { splits } = essence;
    const commonSort = essence.getCommonSort();
    const reference = series.key();
    const sort = new SeriesSort({ reference, period, direction: SortDirection.descending });
    const sortWithDirection = commonSort && commonSort.equals(sort) ? sort.set("direction", SortDirection.ascending) : sort;
    clicker.changeSplits(splits.changeSort(sortWithDirection), VisStrategy.KeepAlways); // set all to measure
  }

  private setSortToDimension() {
    const { clicker, essence: { splits } } = this.props;
    clicker.changeSplits(splits.setSortToDimension(), VisStrategy.KeepAlways); // set each to dimension ascending
  }

  private highlightRow(datum: Datum) {
    const { essence: { splits } } = this.props;
    const rowHighlight = getFilterFromDatum(splits, datum);

    if (!rowHighlight) return;

    const alreadyHighlighted = this.hasHighlight() && rowHighlight.equals(this.getHighlightClauses());
    if (alreadyHighlighted) {
      this.dropHighlight();
      return;
    }

    this.highlight(rowHighlight, null);
  }

  private calculateMousePosition(x: number, y: number, part: ScrollerPart): PositionHover {
    switch (part) {
      case "top-left-corner":
        return { element: HoverElement.CORNER };
      case "top-gutter":
        return seriesPosition(x, this.props.essence, this.getSegmentWidth(), this.getIdealColumnWidth());
      case "body":
      case "left-gutter":
        return rowPosition(y, this.state.flatData);
      default:
        return { element: HoverElement.WHITESPACE };
    }
  }

  onClick = (x: number, y: number, part: ScrollerPart) => {
    this.clearHeaderHover();
    const position = this.calculateMousePosition(x, y, part);

    switch (position.element) {
      case HoverElement.CORNER:
        this.setSortToDimension();
        break;
      case HoverElement.HEADER:
        this.setSortToSeries(position.series, position.period);
        break;
      case HoverElement.ROW:
        this.highlightRow(position.datum);
        break;
    }
  };

  setHoverRow = (x: number, y: number, part: ScrollerPart) => {
    const { hoverRow } = this.state;
    const position = this.calculateMousePosition(x, y, part);
    if (position.element === HoverElement.ROW && position.datum !== hoverRow) {
      this.setState({ hoverRow: position.datum });
    }
    if (position.element === HoverElement.HEADER) {
      this.scheduleHeaderHover(x);
    } else {
      this.clearHeaderHover();
    }
  };

  resetHover = () => {
    const { hoverRow } = this.state;
    this.clearHeaderHover();
    if (hoverRow) {
      this.setState({ hoverRow: null });
    }
  };

  setScroll = (scrollTop: number, scrollLeft: number) => {
    this.clearHeaderHover();
    this.setState({ scrollLeft, scrollTop });
  };

  componentWillUnmount() {
    super.componentWillUnmount();
    window.clearTimeout(this.headerHoverTimer);
  }

  // Measure column headers: show the measure's description card under the hovered header cell.
  private scheduleHeaderHover(x: number) {
    const column = Math.floor((x - this.getSegmentWidth()) / this.getIdealColumnWidth());
    const { headerHover } = this.state;
    if (headerHover && headerHover.column === column) return;
    if (headerHover) this.setState({ headerHover: null });
    if (this.pendingHeaderColumn === column) return;
    window.clearTimeout(this.headerHoverTimer);
    this.pendingHeaderColumn = column;
    this.headerHoverTimer = window.setTimeout(() => {
      this.pendingHeaderColumn = null;
      this.setState({ headerHover: this.headerHoverFor(column) });
    }, HEADER_HOVER_DELAY);
  }

  private headerHoverFor(column: number): HeaderHover | null {
    const { essence } = this.props;
    const inner = this.innerTableRef.current;
    if (!inner || column < 0) return null;
    const perSeries = essence.hasComparison() ? 3 : 1;
    const series = essence.getConcreteSeries().get(Math.floor(column / perSeries));
    if (!series || !series.measure.description) return null;
    const rect = inner.getBoundingClientRect();
    const columnWidth = this.getIdealColumnWidth();
    const left = rect.left + this.getSegmentWidth() + column * columnWidth - (this.state.scrollLeft || 0);
    return {
      column,
      title: series.title(),
      description: series.measure.description,
      anchor: { left, top: rect.top, bottom: rect.top + HEADER_HEIGHT }
    };
  }

  private clearHeaderHover() {
    window.clearTimeout(this.headerHoverTimer);
    this.pendingHeaderColumn = null;
    if (this.state.headerHover) this.setState({ headerHover: null });
  }

  setSegmentWidth = (segmentWidth: number) => this.setState({ segmentWidth });

  private flattenOptions(): FlattenOptions {
    if (this.shouldCollapseRows()) {
      return { order: "inline", nestingName: "__nest" };
    }
    return { order: "preorder", nestingName: "__nest" };
  }

  deriveDatasetState(dataset: Dataset): Partial<TableState> {
    if (!this.props.essence.splits.length()) return {};
    const flatDataset = dataset.flatten(this.flattenOptions());
    const flatData = flatDataset.data;
    return { flatData };
  }

  private getScalesForColumns(essence: Essence, flatData: PseudoDatum[]): Array<d3.scale.Linear<number, number>> {
    const concreteSeries = essence.getConcreteSeries().toArray();
    const splitLength = essence.splits.length();

    return concreteSeries.map(series => {
      const measureValues = flatData
        .filter((d: Datum) => d["__nest"] === splitLength)
        .map((d: Datum) => series.selectValue(d));

      return d3.scale.linear()
        // Ensure that 0 is in there
        .domain(d3.extent([0, ...measureValues]))
        .range([0, 100]);
    });
  }

  private shouldCollapseRows(): boolean {
    const { essence: { visualizationSettings } } = this.props;
    const { collapseRows } = visualizationSettings as ImmutableRecord<TableSettings>;
    return collapseRows;
  }

  private highlightedRowIndex(flatData?: PseudoDatum[]): number | null {
    const { essence } = this.props;
    if (!flatData) return null;
    if (!this.hasHighlight()) return null;
    const { splits } = essence;
    const index = flatData.findIndex(d => this.getHighlightClauses().equals(getFilterFromDatum(splits, d)));
    if (index >= 0) return index;
    return null;
  }

  protected renderInternals() {
    const { essence, stage } = this.props;
    const { flatData, scrollTop, hoverRow, segmentWidth, headerHover } = this.state;
    const collapseRows = this.shouldCollapseRows();

    const highlightedRowIndex = this.highlightedRowIndex(flatData);
    const columnWidth = this.getIdealColumnWidth();

    const columnsCount = measureColumnsCount(essence);
    const rowsCount = flatData ? flatData.length : 0;
    const visibleRowsRange = visibleIndexRange(rowsCount, stage.height, scrollTop);
    const showHighlight = highlightedRowIndex !== null && flatData;

    const scrollerLayout: ScrollerLayout = {
      // Inner dimensions
      bodyWidth: columnWidth * columnsCount + SPACE_RIGHT,
      bodyHeight: rowsCount * ROW_HEIGHT,

      // Gutters
      top: HEADER_HEIGHT,
      right: 0,
      bottom: 0,
      left: this.getSegmentWidth()
    };

    return <div className="internals table-inner" ref={this.innerTableRef}>
      <ResizeHandle
        direction={Direction.LEFT}
        onResize={this.setSegmentWidth}
        min={SEGMENT_WIDTH}
        max={this.maxSegmentWidth()}
        value={segmentWidth}
      />
      <Scroller
        ref="scroller"
        layout={scrollerLayout}

        topGutter={
          <MeasuresHeader
            cellWidth={columnWidth}
            series={essence.getConcreteSeries().toArray()}
            commonSort={essence.getCommonSort()}
            showPrevious={essence.hasComparison()}
          />
        }

        leftGutter={<SplitRows
          collapseRows={collapseRows}
          highlightedRowIndex={highlightedRowIndex}
          visibleRowsIndexRange={visibleRowsRange}
          hoverRow={hoverRow}
          essence={essence}
          data={flatData}
          segmentWidth={this.getSegmentWidth()} />
        }

        topLeftCorner={<SplitsHeader essence={essence} collapseRows={collapseRows} />}

        body={flatData &&
        <MeasureRows
          hoverRow={hoverRow}
          visibleRowsIndexRange={visibleRowsRange}
          essence={essence}
          highlightedRowIndex={highlightedRowIndex}
          scales={this.getScalesForColumns(essence, flatData)}
          data={flatData}
          cellWidth={columnWidth}
          rowWidth={columnWidth * columnsCount} />}

        overlay={showHighlight && <Highlighter
          highlightedIndex={highlightedRowIndex}
          highlightedNesting={flatData[highlightedRowIndex].__nest}
          scrollTopOffset={scrollTop}
          collapseRows={collapseRows} />}

        onClick={this.onClick}
        onMouseMove={this.setHoverRow}
        onMouseLeave={this.resetHover}
        onScroll={this.setScroll}

      />

      {headerHover && <DescriptionBubble
        anchor={headerHover.anchor}
        title={headerHover.title}
        description={headerHover.description} />}

      {highlightedRowIndex !== null &&
      <HighlightModal
        title={nestedSplitName(flatData[highlightedRowIndex], essence)}
        left={stage.x + stage.width / 2}
        top={stage.y + HEADER_HEIGHT + (highlightedRowIndex * ROW_HEIGHT) - scrollTop - HIGHLIGHT_BUBBLE_V_OFFSET}
        acceptHighlight={this.acceptHighlight}
        dropHighlight={this.dropHighlight} />}
    </div>;
  }
}
