/***
 * DONE: Reduce layout processing on data insert
 * DONE: Add notify data set changed and notify data insert option in data source
 * DONE: Add on end reached callback
 * DONE: Make another class for render stack generator
 * DONE: Simplify rendering a loading footer
 * DONE: Anchor first visible index on any insert/delete data wise
 * DONE: Build Scroll to index
 * DONE: Give viewability callbacks
 * DONE: Add full render logic in cases like change of dimensions
 * DONE: Fix all proptypes
 * DONE: Add Initial render Index support
 * TODO: Destroy less frequently used items in recycle pool, this will help in case of too many types.
 * TODO: Add animated scroll to web scrollviewer
 * TODO: Animate list view transition, including add/remove
 * TODO: Implement sticky headers
 * TODO: Make viewability callbacks configurable
 * TODO: Observe size changes on web to optimize for reflowability
 */
import debounce from "lodash-es/debounce";
import * as PropTypes from "prop-types";
import * as React from "react";
import ContextProvider from "./dependencies/ContextProvider";
import DataProvider from "./dependencies/DataProvider";
import LayoutProvider, { Dimension } from "./dependencies/LayoutProvider";
import CustomError from "./exceptions/CustomError";
import RecyclerListViewExceptions from "./exceptions/RecyclerListViewExceptions";
import LayoutManager, { Point, Rect } from "./layoutmanager/LayoutManager";
import Messages from "./messages/Messages";
import BaseScrollComponent from "./scrollcomponent/BaseScrollComponent";
import { ScrollEvent } from "./scrollcomponent/BaseScrollView";
import { TOnItemStatusChanged } from "./ViewabilityTracker";
import VirtualRenderer, { RenderStack, RenderStackItem, RenderStackParams } from "./VirtualRenderer";

//#if [REACT-NATIVE]
import ScrollComponent from "../platform/reactnative/scrollcomponent/ScrollComponent";
import ViewRenderer from "../platform/reactnative/viewrenderer/ViewRenderer";
//#endif

/***
 * To use on web, start importing from recyclerlistview/web. To make it even easier specify an alias in you builder of choice.
 */

//#if [WEB]
//import ScrollComponent from "../platform/web/scrollcomponent/ScrollComponent";
//import ViewRenderer from "../platform/web/viewrenderer/ViewRenderer";
//#endif

const refreshRequestDebouncer = debounce((executable: () => void) => {
    executable();
});

/***
 * This is the main component, please refer to samples to understand how to use.
 * For advanced usage check out prop descriptions below.
 * You also get common methods such as: scrollToIndex, scrollToItem, scrollToTop, scrollToEnd, scrollToOffset, getCurrentScrollOffset,
 * findApproxFirstVisibleIndex.
 * You'll need a ref to Recycler in order to call these
 * Needs to have bounded size in all cases other than window scrolling (web).
 *
 * NOTE: React Native implementation uses ScrollView internally which means you get all ScrollView features as well such as Pull To Refresh, paging enabled
 *       You can easily create a recycling image flip view using one paging enabled flag. Read about ScrollView features in official
 *       react native documentation.
 * NOTE: If you see blank space look at the renderAheadOffset prop and make sure your data provider has a good enough rowHasChanged method.
 *       Blanks are totally avoidable with this listview.
 * NOTE: Also works on web (experimental)
 * NOTE: For reflowability set canChangeSize to true (experimental)
 */

export interface RecyclerListViewProps {
    layoutProvider: LayoutProvider;
    dataProvider: DataProvider<any>;
    contextProvider: ContextProvider;
    rowRenderer: (type: string | number, data: any, index: number) => JSX.Element;
    renderAheadOffset: number;
    isHorizontal: boolean;
    onScroll: (rawEvent: ScrollEvent, offsetX: number, offsetY: number) => void;
    onEndReached: () => void;
    onEndReachedThreshold: number;
    onVisibleIndexesChanged: TOnItemStatusChanged;
    renderFooter: () => JSX.Element;
    initialOffset: number;
    initialRenderIndex: number;
    scrollThrottle: number;
    canChangeSize: boolean;
    distanceFromWindow: number;
    useWindowScroll: boolean;
    disableRecycling: boolean;
    forceNonDeterministicRendering: boolean;
}
export interface RecyclerListViewState {
    renderStack: RenderStack;
}

export default class RecyclerListView extends React.Component<RecyclerListViewProps, RecyclerListViewState> {
    public static defaultProps = {
        canChangeSize: false,
        disableRecycling: false,
        initialOffset: 0,
        initialRenderIndex: 0,
        isHorizontal: false,
        onEndReachedThreshold: 0,
        renderAheadOffset: 250,
    };

    public static propTypes = {};

    private _onEndReachedCalled = false;

    private _virtualRenderer: VirtualRenderer;

    private _initComplete = false;
    private _relayoutReqIndex: number = -1;
    private _params: RenderStackParams = {
        initialOffset: 0,
        initialRenderIndex: 0,
        isHorizontal: false,
        itemCount: 0,
        renderAheadOffset: 250,
    };
    private _layout: Dimension = {height: 0, width: 0};
    private _pendingScrollToOffset: Point | null = null;
    private _tempDim: Dimension = { height : 0, width : 0};
    private _initialOffset = 0;
    private _cachedLayouts: Rect[] | null = null;
    private _scrollComponent: BaseScrollComponent | null;

    constructor(props: RecyclerListViewProps) {
        super(props);
        this._onScroll = this._onScroll.bind(this);
        this._onSizeChanged = this._onSizeChanged.bind(this);
        this._onVisibleItemsChanged = this._onVisibleItemsChanged.bind(this);
        this._dataHasChanged = this._dataHasChanged.bind(this);
        this.scrollToOffset = this.scrollToOffset.bind(this);
        this._renderStackWhenReady = this._renderStackWhenReady.bind(this);
        this._onViewContainerSizeChange = this._onViewContainerSizeChange.bind(this);

        this._virtualRenderer = new VirtualRenderer(this._renderStackWhenReady, (offset) => {
            this._pendingScrollToOffset = offset;
        }, !props.disableRecycling);

        this.state = {
            renderStack: {},
        };
    }

    public componentWillReceiveProps(newProps: RecyclerListViewProps) {
        this._assertDependencyPresence(newProps);
        this._checkAndChangeLayouts(newProps);
        if (!this.props.onVisibleIndexesChanged) {
            this._virtualRenderer.removeVisibleItemsListener();
        } else {
            this._virtualRenderer.attachVisibleItemsListener(this._onVisibleItemsChanged);
        }
    }

    public componentDidUpdate() {
        if (this._pendingScrollToOffset) {
            const offset = this._pendingScrollToOffset;
            this._pendingScrollToOffset = null;
            if (this.props.isHorizontal) {
                offset.y = 0;
            } else {
                offset.x = 0;
            }
            setTimeout(() => {
                this.scrollToOffset(offset.x, offset.y, false);
            }, 0);
        }
        this._processOnEndReached();
        this._checkAndChangeLayouts(this.props);
    }

    public componentWillUnmount() {
        if (this.props.contextProvider) {
            const uniqueKey = this.props.contextProvider.getUniqueKey();
            if (uniqueKey) {
                this.props.contextProvider.save(uniqueKey, this.getCurrentScrollOffset());
                if (this.props.forceNonDeterministicRendering) {
                    if (this._virtualRenderer) {
                        const layoutManager = this._virtualRenderer.getLayoutManager();
                        if (layoutManager) {
                            const layoutsToCache = layoutManager.getLayouts();
                            this.props.contextProvider.save(uniqueKey + "_layouts", JSON.stringify({layoutArray: layoutsToCache}));
                        }
                    }
                }
            }
        }
    }

    public componentWillMount() {
        if (this.props.contextProvider) {
            const uniqueKey = this.props.contextProvider.getUniqueKey();
            if (uniqueKey) {
                const offset = this.props.contextProvider.get(uniqueKey);
                if (typeof offset === "number" && offset > 0) {
                    this._initialOffset = offset;
                }
                if (this.props.forceNonDeterministicRendering) {
                    const cachedLayouts = this.props.contextProvider.get(uniqueKey + "_layouts") as string;
                    if (cachedLayouts && typeof cachedLayouts === "string") {
                        this._cachedLayouts = JSON.parse(cachedLayouts).layoutArray;
                    }
                }
                this.props.contextProvider.remove(uniqueKey);
            }
        }
    }

    public scrollToIndex(index: number, animate?: boolean) {
        const layoutManager = this._virtualRenderer.getLayoutManager();
        if (layoutManager) {
            const offsets = layoutManager.getOffsetForIndex(index);
            this.scrollToOffset(offsets.x, offsets.y, animate);
        } else {
            console.warn(Messages.WARN_SCROLL_TO_INDEX); //tslint:disable-line
        }
    }

    public scrollToItem(data: any, animate?: boolean) {
        const count = this.props.dataProvider.getSize();
        for (let i = 0; i < count; i++) {
            if (this.props.dataProvider.getDataForIndex(i) === data) {
                this.scrollToIndex(i, animate);
                break;
            }
        }
    }

    public scrollToTop(animate?: boolean) {
        this.scrollToOffset(0, 0, animate);
    }

    public scrollToEnd(animate?: boolean) {
        const lastIndex = this.props.dataProvider.getSize() - 1;
        this.scrollToIndex(lastIndex, animate);
    }

    public scrollToOffset(x: number, y: number, animate: boolean = false) {
        if (this._scrollComponent) {
            this._scrollComponent.scrollTo(x, y, animate);
        }
    }

    public getCurrentScrollOffset() {
        const viewabilityTracker = this._virtualRenderer.getViewabilityTracker();
        return viewabilityTracker ? viewabilityTracker.getLastOffset() : 0;
    }

    public findApproxFirstVisibleIndex() {
        const viewabilityTracker = this._virtualRenderer.getViewabilityTracker();
        return viewabilityTracker ? viewabilityTracker.findFirstLogicallyVisibleIndex() : 0;
    }

    public _checkAndChangeLayouts(newProps: RecyclerListViewProps, forceFullRender?: boolean) {
        this._params.isHorizontal = newProps.isHorizontal;
        this._params.itemCount = newProps.dataProvider.getSize();
        this._virtualRenderer.setParamsAndDimensions(this._params, this._layout);
        if (forceFullRender || this.props.layoutProvider !== newProps.layoutProvider || this.props.isHorizontal !== newProps.isHorizontal) {
            //TODO:Talha use old layout manager
            this._virtualRenderer.setLayoutManager(new LayoutManager(newProps.layoutProvider, this._layout, newProps.isHorizontal, null));
            this._virtualRenderer.refreshWithAnchor();
        } else if (this.props.dataProvider !== newProps.dataProvider) {
            const layoutManager = this._virtualRenderer.getLayoutManager();
            if (layoutManager) {
                layoutManager.reLayoutFromIndex(newProps.dataProvider.getFirstIndexToProcessInternal(), newProps.dataProvider.getSize());
                this._virtualRenderer.refresh();
            }
        } else if (this._relayoutReqIndex >= 0) {
            const layoutManager = this._virtualRenderer.getLayoutManager();
            if (layoutManager) {
                layoutManager.reLayoutFromIndex(this._relayoutReqIndex, newProps.dataProvider.getSize());
                this._relayoutReqIndex = -1;
                this._refreshViewability();
            }
        }
    }

    public _refreshViewability() {
        this._virtualRenderer.refresh();
        this._queueStateRefresh();

    }

    public _queueStateRefresh() {
        refreshRequestDebouncer(() => {
            this.setState((prevState) => {
                return prevState;
            });
        });
    }

    public _onSizeChanged(layout: Dimension) {
        const hasHeightChanged = this._layout.height !== layout.height;
        const hasWidthChanged = this._layout.width !== layout.width;
        this._layout.height = layout.height;
        this._layout.width = layout.width;
        if (layout.height === 0 || layout.width === 0) {
            throw new CustomError(RecyclerListViewExceptions.layoutException);
        }
        if (!this._initComplete) {
            this._initComplete = true;
            this._initTrackers();
            this._processOnEndReached();
        } else {
            if ((hasHeightChanged && hasWidthChanged) ||
                (hasHeightChanged && this.props.isHorizontal) ||
                (hasWidthChanged && !this.props.isHorizontal)) {
                this._checkAndChangeLayouts(this.props, true);
            } else {
                this._refreshViewability();
            }
        }
    }

    public _renderStackWhenReady(stack: RenderStack) {
        this.setState(() => {
            return {renderStack: stack};
        });
    }

    public _initTrackers() {
        this._assertDependencyPresence(this.props);
        if (this.props.onVisibleIndexesChanged) {
            this._virtualRenderer.attachVisibleItemsListener(this._onVisibleItemsChanged);
        }
        this._params = {
            initialOffset: this.props.initialOffset ? this.props.initialOffset : this._initialOffset,
            initialRenderIndex: this.props.initialRenderIndex,
            isHorizontal: this.props.isHorizontal,
            itemCount: this.props.dataProvider.getSize(),
            renderAheadOffset: this.props.renderAheadOffset,
        };
        this._virtualRenderer.setParamsAndDimensions(this._params, this._layout);
        this._virtualRenderer.setLayoutManager(new LayoutManager(this.props.layoutProvider, this._layout, this.props.isHorizontal, this._cachedLayouts));
        this._virtualRenderer.setLayoutProvider(this.props.layoutProvider);
        this._virtualRenderer.init();
        const offset = this._virtualRenderer.getInitialOffset();
        if (offset.y > 0 || offset.x > 0) {
            this._pendingScrollToOffset = offset;
            this.setState({});
        } else {
            this._virtualRenderer.startViewabilityTracker();
        }
        this._cachedLayouts = null;
    }

    public _onVisibleItemsChanged(all: number[], now: number[], notNow: number[]) {
        this.props.onVisibleIndexesChanged(all, now, notNow);

    }

    public _assertDependencyPresence(props: RecyclerListViewProps) {
        if (!props.dataProvider || !props.layoutProvider) {
            throw new CustomError(RecyclerListViewExceptions.unresolvedDependenciesException);
        }
    }

    public _assertType(type: string | number) {
        if (!type && type !== 0) {
            throw new CustomError(RecyclerListViewExceptions.itemTypeNullException);
        }
    }

    public _dataHasChanged(row1: any, row2: any) {
        return this.props.dataProvider.rowHasChanged(row1, row2);
    }

    public _renderRowUsingMeta(itemMeta: RenderStackItem): JSX.Element | null {
        const dataSize = this.props.dataProvider.getSize();
        const dataIndex = itemMeta.dataIndex;
        if (dataIndex && dataIndex < dataSize) {
            const itemRect = (this._virtualRenderer.getLayoutManager() as LayoutManager).getLayouts()[dataIndex];
            const data = this.props.dataProvider.getDataForIndex(dataIndex);
            const type = this.props.layoutProvider.getLayoutTypeForIndex(dataIndex);
            this._assertType(type);
            if (!this.props.forceNonDeterministicRendering) {
                this._checkExpectedDimensionDiscrepancy(itemRect, type, dataIndex);
            }
            return (
                <ViewRenderer key={itemMeta.key} data={data}
                              dataHasChanged={this._dataHasChanged}
                              x={itemRect.x}
                              y={itemRect.y}
                              layoutType={type}
                              index={dataIndex}
                              forceNonDeterministicRendering={this.props.forceNonDeterministicRendering}
                              isHorizontal={this.props.isHorizontal}
                              onSizeChanged={this._onViewContainerSizeChange}
                              childRenderer={this.props.rowRenderer}
                              height={itemRect.height}
                              width={itemRect.width}/>
            );
        }
        return null;
    }

    public _onViewContainerSizeChange(dim: Dimension, index: number) {
        //Cannot be null here
        (this._virtualRenderer.getLayoutManager() as LayoutManager).overrideLayout(index, dim);
        if (this._relayoutReqIndex === -1) {
            this._relayoutReqIndex = index;
        } else {
            this._relayoutReqIndex = Math.min(this._relayoutReqIndex, index);
        }
        this._queueStateRefresh();
    }

    public _checkExpectedDimensionDiscrepancy(itemRect: Dimension, type: string | number, index: number) {
        //Cannot be null here
        const layoutManager = this._virtualRenderer.getLayoutManager() as LayoutManager;
        layoutManager.setMaxBounds(this._tempDim);
        this.props.layoutProvider.setLayoutForType(type, this._tempDim, index);

        //TODO:Talha calling private method, find an alternative and remove this
        layoutManager.setMaxBounds(this._tempDim);
        if (itemRect.height !== this._tempDim.height || itemRect.width !== this._tempDim.width) {
            if (this._relayoutReqIndex === -1) {
                this._relayoutReqIndex = index;
            } else {
                this._relayoutReqIndex = Math.min(this._relayoutReqIndex, index);
            }
        }
    }

    public _generateRenderStack() {
        const renderedItems = [];
        for (const key in this.state.renderStack) {
            if (this.state.renderStack.hasOwnProperty(key)) {
                renderedItems.push(this._renderRowUsingMeta(this.state.renderStack[key]));

            }
        }
        return renderedItems;
    }

    public _onScroll(offsetX: number, offsetY: number, rawEvent: ScrollEvent) {
        this._virtualRenderer.updateOffset(offsetX, offsetY);
        if (this.props.onScroll) {
            this.props.onScroll(rawEvent, offsetX, offsetY);
        }
        this._processOnEndReached();
    }

    public _processOnEndReached() {
        if (this.props.onEndReached && this._virtualRenderer) {
            const layout = this._virtualRenderer.getLayoutDimension();
            const windowBound = this.props.isHorizontal ? layout.width - this._layout.width : layout.height - this._layout.height;
            const viewabilityTracker = this._virtualRenderer.getViewabilityTracker();
            const lastOffset = viewabilityTracker ? viewabilityTracker.getLastOffset() : 0;
            if (windowBound - lastOffset <= this.props.onEndReachedThreshold) {
                if (!this._onEndReachedCalled) {
                    this._onEndReachedCalled = true;
                    this.props.onEndReached();
                }
            } else {
                this._onEndReachedCalled = false;
            }
        }
    }

    public render() {
        return (
            <ScrollComponent
                ref={(scrollComponent) => this._scrollComponent = scrollComponent as BaseScrollComponent | null}
                {...this.props}
                onScroll={this._onScroll}
                onSizeChanged={this._onSizeChanged}
                contentHeight={this._initComplete ? this._virtualRenderer.getLayoutDimension().height : 0}
                contentWidth={this._initComplete ? this._virtualRenderer.getLayoutDimension().width : 0}>
                {this._generateRenderStack()}
            </ScrollComponent>

        );
    }
}

RecyclerListView.propTypes = {

    //Refer the sample
    layoutProvider: PropTypes.instanceOf(LayoutProvider).isRequired,

    //Refer the sample
    dataProvider: PropTypes.instanceOf(DataProvider).isRequired,

    //Used to maintain scroll position in case view gets destroyed e.g, cases of back navigation
    contextProvider: PropTypes.instanceOf(ContextProvider),

    //Methods which returns react component to be rendered. You get type of view and data in the callback.
    rowRenderer: PropTypes.func.isRequired,

    //Initial offset you want to start rendering from, very useful if you want to maintain scroll context across pages.
    initialOffset: PropTypes.number,

    //Specify how many pixels in advance do you want views to be rendered. Increasing this value can help reduce blanks (if any). However keeping this as low
    //as possible should be the intent. Higher values also increase re-render compute
    renderAheadOffset: PropTypes.number,

    //Whether the listview is horizontally scrollable. Both use staggeredGrid implementation
    isHorizontal: PropTypes.bool,

    //On scroll callback onScroll(rawEvent, offsetX, offsetY), note you get offsets no need to read scrollTop/scrollLeft
    onScroll: PropTypes.func,

    //Provide your own ScrollView Component. The contract for the scroll event should match the native scroll event contract, i.e.
    // scrollEvent = { nativeEvent: { contentOffset: { x: offset, y: offset } } }
    externalScrollView: PropTypes.func,

    //Callback given when user scrolls to the end of the list or footer just becomes visible, useful in incremental loading scenarios
    onEndReached: PropTypes.func,

    //Specify how many pixels in advance you onEndReached callback
    onEndReachedThreshold: PropTypes.number,

    //Provides visible index, helpful in sending impression events etc, onVisibleIndexesChanged(all, now, notNow)
    onVisibleIndexesChanged: PropTypes.func,

    //Provide this method if you want to render a footer. Helpful in showing a loader while doing incremental loads.
    renderFooter: PropTypes.func,

    //Specify the initial item index you want rendering to start from. Preferred over initialOffset if both are specified.
    initialRenderIndex: PropTypes.number,

    //iOS only. Scroll throttle duration.
    scrollThrottle: PropTypes.number,

    //Specify if size can change, listview will automatically relayout items. For web, works only with useWindowScroll = true
    canChangeSize: PropTypes.bool,

    //Web only. Specify how far away the first list item is from window top. This is an adjustment for better optimization.
    distanceFromWindow: PropTypes.number,

    //Web only. Layout elements in window instead of a scrollable div.
    useWindowScroll: PropTypes.bool,

    //Turns off recycling. You still get progressive rendering and all other features. Good for lazy rendering. This should not be used in most cases.
    disableRecycling: PropTypes.bool,

    //Default is false, if enabled dimensions provided in layout provider will not be strictly enforced.
    //Rendered dimensions will be used to relayout items. Slower if enabled.
    forceNonDeterministicRendering: PropTypes.bool,
};
