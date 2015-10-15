'use strict';
require('./split-tile.css');

import { List } from 'immutable';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { SvgIcon } from '../svg-icon/svg-icon';
import { $, Expression, Executor, Dataset } from 'plywood';
import { CORE_ITEM_WIDTH, CORE_ITEM_GAP } from '../../config/constants';
import { Stage, Clicker, Essence, VisStrategy, DataSource, Filter, SplitCombine, Dimension, Measure } from '../../../common/models/index';
import { calculateDragPosition, DragPosition } from '../../../common/utils/general/general';
import { findParentWithClass, dataTransferTypesGet, setDragGhost, transformStyle, getXFromEvent } from '../../utils/dom/dom';
import { FancyDragIndicator } from '../fancy-drag-indicator/fancy-drag-indicator';
import { SplitMenu } from '../split-menu/split-menu';

const SPLIT_CLASS_NAME = 'split';

export interface SplitTileProps {
  clicker: Clicker;
  essence: Essence;
  menuStage: Stage;

  ref?: any;
}

export interface SplitTileState {
  SplitMenuAsync?: typeof SplitMenu;
  menuOpenOn?: Element;
  menuDimension?: Dimension;
  menuSplit?: SplitCombine;
  dragOver?: boolean;
  dragInsertPosition?: number;
  dragReplacePosition?: number;
}

export class SplitTile extends React.Component<SplitTileProps, SplitTileState> {
  private dragCounter: number;

  constructor() {
    super();
    this.state = {
      SplitMenuAsync: null,
      menuOpenOn: null,
      menuDimension: null,
      dragOver: false,
      dragInsertPosition: null,
      dragReplacePosition: null
    };
  }

  componentDidMount() {
    require.ensure(['../split-menu/split-menu'], (require) => {
      this.setState({
        SplitMenuAsync: require('../split-menu/split-menu').SplitMenu
      });
    }, 'split-menu');
  }

  selectDimensionSplit(dimension: Dimension, split: SplitCombine, e: MouseEvent) {
    var target = findParentWithClass(<Element>e.target, SPLIT_CLASS_NAME);
    this.openMenu(dimension, split, target);
  }

  openMenu(dimension: Dimension, split: SplitCombine, target: Element) {
    var { menuOpenOn } = this.state;
    if (menuOpenOn === target) {
      this.closeMenu();
      return;
    }
    this.setState({
      menuOpenOn: target,
      menuDimension: dimension,
      menuSplit: split
    });
  }

  closeMenu() {
    if (!this.state.menuOpenOn) return;
    this.setState({
      menuOpenOn: null,
      menuDimension: null,
      menuSplit: null
    });
  }

  removeSplit(split: SplitCombine, e: MouseEvent) {
    var { clicker } = this.props;
    clicker.removeSplit(split, VisStrategy.FairGame);
    this.closeMenu();
    e.stopPropagation();
  }

  dragStart(dimension: Dimension, split: SplitCombine, splitIndex: number, e: DragEvent) {
    var { essence } = this.props;

    var newUrl = essence.changeSplit(SplitCombine.fromExpression(dimension.expression), VisStrategy.FairGame).getURL();

    var dataTransfer = e.dataTransfer;
    dataTransfer.effectAllowed = 'all';
    dataTransfer.setData("text/url-list", newUrl);
    dataTransfer.setData("text/plain", newUrl);
    dataTransfer.setData("split/" + splitIndex, JSON.stringify(split));
    dataTransfer.setData("dimension/" + dimension.name, JSON.stringify(dimension));
    setDragGhost(dataTransfer, dimension.title);
  }

  calculateDragPosition(e: DragEvent): DragPosition {
    var { essence } = this.props;
    var numItems = essence.splits.length();
    var rect = ReactDOM.findDOMNode(this.refs['items']).getBoundingClientRect();
    var x = getXFromEvent(e);
    var offset = x - rect.left;
    return calculateDragPosition(offset, numItems, CORE_ITEM_WIDTH, CORE_ITEM_GAP);
  }

  canDrop(e: DragEvent): boolean {
    return Boolean(dataTransferTypesGet(e.dataTransfer.types, "split") ||
      dataTransferTypesGet(e.dataTransfer.types, "dimension"));
  }

  dragOver(e: DragEvent) {
    if (!this.canDrop(e)) return;
    e.dataTransfer.dropEffect = 'move';
    e.preventDefault();
    this.setState(this.calculateDragPosition(e));
  }

  dragEnter(e: DragEvent) {
    if (!this.canDrop(e)) return;
    var { dragOver } = this.state;
    if (!dragOver) {
      this.dragCounter = 0;
      var newState: SplitTileState = this.calculateDragPosition(e);
      newState.dragOver = true;
      this.setState(newState);
    } else {
      this.dragCounter++;
    }
  }

  dragLeave(e: DragEvent) {
    if (!this.canDrop(e)) return;
    var { dragOver } = this.state;
    if (!dragOver) return;
    if (this.dragCounter === 0) {
      this.setState({
        dragOver: false,
        dragInsertPosition: null,
        dragReplacePosition: null
      });
    } else {
      this.dragCounter--;
    }
  }

  drop(e: DragEvent) {
    if (!this.canDrop(e)) return;
    e.preventDefault();
    var { clicker, essence } = this.props;
    var { splits } = essence;

    var newSplitCombine: SplitCombine = null;
    var splitIndex = parseInt(dataTransferTypesGet(e.dataTransfer.types, "split"), 10);
    if (!isNaN(splitIndex)) {
      newSplitCombine = splits.get(splitIndex);
    } else {
      var dimensionName = dataTransferTypesGet(e.dataTransfer.types, "dimension");
      if (dimensionName) {
        var dimension = essence.dataSource.getDimension(dimensionName);
        if (dimension) {
          newSplitCombine = SplitCombine.fromExpression(dimension.expression);
        }
      }
    }

    if (newSplitCombine) {
      var { dragReplacePosition, dragInsertPosition } = this.calculateDragPosition(e);
      if (dragReplacePosition !== null) {
        clicker.changeSplits(splits.replaceByIndex(dragReplacePosition, newSplitCombine), VisStrategy.FairGame);
      } else if (dragInsertPosition !== null) {
        clicker.changeSplits(splits.insertByIndex(dragInsertPosition, newSplitCombine), VisStrategy.FairGame);
      }
    }

    this.dragCounter = 0;
    this.setState({
      dragOver: false,
      dragInsertPosition: null,
      dragReplacePosition: null
    });
  }

  // This will be called externally
  splitMenuRequest(dimension: Dimension) {
    var { splits } = this.props.essence;
    var split = splits.findSplitForDimension(dimension);
    if (!split) return;
    var targetRef = this.refs[dimension.name];
    if (!targetRef) return;
    var target = ReactDOM.findDOMNode(targetRef);
    if (!target) return;
    this.openMenu(dimension, split, target);
  }

  renderMenu(): React.ReactElement<any> {
    var { essence, clicker, menuStage } = this.props;
    var { SplitMenuAsync, menuOpenOn, menuDimension, menuSplit } = this.state;
    if (!SplitMenuAsync || !menuDimension) return null;
    var onClose = this.closeMenu.bind(this);

    return JSX(`
      <SplitMenuAsync
        clicker={clicker}
        essence={essence}
        direction="down"
        containerStage={menuStage}
        openOn={menuOpenOn}
        dimension={menuDimension}
        split={menuSplit}
        onClose={onClose}
      />
    `);
  }

  render() {
    var { essence } = this.props;
    var { menuDimension, dragOver, dragInsertPosition, dragReplacePosition } = this.state;
    var { dataSource, splits } = essence;

    var sectionWidth = CORE_ITEM_WIDTH + CORE_ITEM_GAP;

    var itemX = 0;
    var splitItems = splits.toArray().map((split, i) => {
      var dimension = split.getDimension(dataSource);
      if (!dimension) throw new Error('dimension not found');
      var dimensionName = dimension.name;

      var style = transformStyle(itemX, 0);
      itemX += sectionWidth;

      var classNames = [
        SPLIT_CLASS_NAME,
        'type-' + dimension.className
      ];
      if (dimension === menuDimension) classNames.push('selected');
      return JSX(`
        <div
          className={classNames.join(' ')}
          key={split.toKey()}
          ref={dimensionName}
          draggable="true"
          onClick={this.selectDimensionSplit.bind(this, dimension, split)}
          onDragStart={this.dragStart.bind(this, dimension, split, i)}
          style={style}
        >
          <div className="reading">{split.getTitle(dataSource)}</div>
          <div className="remove" onClick={this.removeSplit.bind(this, split)}>
            <SvgIcon svg={require('../../icons/x.svg')}/>
          </div>
        </div>
      `);
    }, this);

    var fancyDragIndicator: React.ReactElement<any> = null;
    if (dragInsertPosition !== null || dragReplacePosition !== null) {
      fancyDragIndicator = React.createElement(FancyDragIndicator, {
        dragInsertPosition,
        dragReplacePosition
      });
    }

    return JSX(`
      <div
        className={'split-tile ' + (dragOver ? 'drag-over' : 'no-drag')}
        onDragOver={this.dragOver.bind(this)}
        onDragEnter={this.dragEnter.bind(this)}
        onDragLeave={this.dragLeave.bind(this)}
        onDrop={this.drop.bind(this)}
      >
        <div className="title">Split</div>
        <div className="items" ref="items">
          {splitItems}
        </div>
        {fancyDragIndicator}
        {this.renderMenu()}
      </div>
    `);
  }
}
